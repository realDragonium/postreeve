import {
  ImapFlow,
  type AppendResponseObject,
  type CopyResponseObject,
  type ESearchResult,
  type FetchOptions,
  type FetchQueryObject,
  type FetchMessageObject,
  type ImapFlowOptions,
  type DownloadObject,
  type ListOptions,
  type ListResponse,
  type MailboxObject,
  type MailboxOpenOptions,
  type MessageStructureObject,
  type SearchObject,
  type StatusObject,
  type StoreOptions,
} from "imapflow";
import { simpleParser, type EmailAddress, type ParsedMail } from "mailparser";

import type {
  Draft,
  Folder,
  MessageRef,
  MessageSummary,
  TriageAction,
  ProviderDraftRef,
} from "../../shared/contracts";
import type {
  AppliedMailAction,
  MailboxPage,
  MailProvider,
  ProviderLocationMove,
  ProviderMessageDetail,
  ProviderMessageSummary,
  ProviderDraft,
  ProviderDraftScope,
  ProviderAttachment,
  ProviderAttachmentDownload,
  ProviderAttachmentLocator,
} from "./provider";
import { safeAttachmentFilename, safeAttachmentMediaType } from "../core/attachment-reference";
import { buildProviderDraftMessage, parseProviderDraftMarkers } from "./provider-draft";
import { normalizeIdentificationFields, normalizeReferenceSequences } from "./message-id";

export interface ImapAccountConfig {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface ImapClient {
  capabilities: Map<string, boolean | number>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(options?: ListOptions): Promise<ListResponse[]>;
  mailboxCreate(path: string | string[]): Promise<unknown>;
  mailboxRename(path: string | string[], newPath: string | string[]): Promise<unknown>;
  mailboxDelete(path: string | string[]): Promise<unknown>;
  mailboxOpen(path: string | string[], options?: MailboxOpenOptions): Promise<MailboxObject>;
  status(
    path: string | string[],
    query: { uidValidity?: boolean },
  ): Promise<StatusObject>;
  search(
    query: SearchObject,
    options: { uid?: boolean; returnOptions: Array<"MIN" | "MAX" | "COUNT" | "ALL" | { partial: string }> },
  ): Promise<ESearchResult | number[] | false>;
  fetch(
    range: number[],
    query: FetchQueryObject,
    options?: FetchOptions,
  ): AsyncIterableIterator<FetchMessageObject>;
  fetchOne(
    sequence: number,
    query: FetchQueryObject,
    options?: FetchOptions,
  ): Promise<FetchMessageObject | false>;
  download(
    range: number,
    part?: string,
    options?: { uid?: boolean; maxBytes?: number; chunkSize?: number },
  ): Promise<DownloadObject>;
  messageFlagsAdd(
    range: number,
    flags: string[],
    options?: StoreOptions,
  ): Promise<boolean>;
  messageFlagsRemove(
    range: number,
    flags: string[],
    options?: StoreOptions,
  ): Promise<boolean>;
  messageMove(
    range: number,
    destination: string | string[],
    options?: { uid?: boolean },
  ): Promise<CopyResponseObject | false>;
  messageDelete(range: number | number[], options?: { uid?: boolean }): Promise<boolean>;
  append(
    path: string | string[],
    content: string | Buffer,
    flags?: string[],
    idate?: Date | string,
  ): Promise<AppendResponseObject | false>;
}

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient;

const SUMMARY_SOURCE_BYTES = 64 * 1024;
const SEEN_FLAG = "\\Seen";
const DRAFT_FLAG = "\\Draft";
const DELETED_FLAG = "\\Deleted";
const MAX_PROVIDER_DRAFTS = 1_000;
const providerDraftMarkerHeaders: string[] = [
  "X-Postreeve-Draft-Tenant-ID",
  "X-Postreeve-Draft-Account-ID",
  "X-Postreeve-Draft-ID",
  "X-Postreeve-Draft-Version",
];

type ListedProviderDraft = ProviderDraft & { readonly deleted: boolean };

const defaultClientFactory: ImapClientFactory = (options) => new ImapFlow(options);

export class ImapMailProvider implements MailProvider {
  readonly #config: ImapAccountConfig;
  readonly #createClient: ImapClientFactory;

  constructor(config: ImapAccountConfig, createClient: ImapClientFactory = defaultClientFactory) {
    if (!config.accountId) throw new Error("An IMAP account ID is required");
    this.#config = { ...config };
    this.#createClient = createClient;
  }

  async verifyConnection(): Promise<void> {
    await this.#withClient(async (client) => {
      await client.list();
    });
  }

  async listFolders(accountId: string): Promise<Folder[]> {
    this.#assertAccount(accountId);
    return this.#withClient(async (client) => {
      const mailboxes = await client.list({
        statusQuery: { messages: true, unseen: true },
      });

      return mailboxes
        .filter((mailbox) => !hasFlag(mailbox.flags, "\\Noselect"))
        .map((mailbox) => ({
          path: mailbox.path,
          name: mailbox.name,
          specialUse: specialUseFor(mailbox),
          unread: mailbox.status?.unseen ?? 0,
          total: mailbox.status?.messages ?? 0,
        }));
    });
  }

  async createFolder(accountId: string, name: string): Promise<void> {
    this.#assertAccount(accountId);
    await this.#withClient(async (client) => {
      await client.mailboxCreate(name);
    });
  }

  async renameFolder(accountId: string, path: string, name: string): Promise<void> {
    this.#assertAccount(accountId);
    await this.#withClient(async (client) => {
      const mailbox = await manageableMailbox(client, path);
      const newPath = renamedMailboxPath(mailbox, name);
      if (newPath !== path) await client.mailboxRename(path, newPath);
    });
  }

  async deleteFolder(accountId: string, path: string): Promise<void> {
    this.#assertAccount(accountId);
    await this.#withClient(async (client) => {
      const mailbox = await manageableMailbox(client, path, true);
      if ((mailbox.status?.messages ?? 0) > 0) {
        throw new Error("Move every message out of this IMAP folder before deleting it");
      }
      await client.mailboxDelete(path);
    });
  }

  async createDraft(scope: ProviderDraftScope, draft: Draft): Promise<ProviderDraftRef> {
    this.#assertDraftScope(scope, draft);
    return this.#withClient((client) => this.#replaceDraft(client, scope, draft));
  }

  async updateDraft(scope: ProviderDraftScope, draft: Draft, ref: ProviderDraftRef): Promise<ProviderDraftRef> {
    this.#assertDraftScope(scope, draft);
    if (ref.kind !== "imap") throw new Error("IMAP cannot update a draft reference from another provider");
    return this.#withClient((client) => this.#replaceDraft(client, scope, draft, ref));
  }

  async listDrafts(scope: ProviderDraftScope): Promise<ProviderDraft[]> {
    this.#assertDraftScope(scope);
    return this.#withClient((client) => this.#listProviderDrafts(client, scope));
  }

  async removeDraft(scope: ProviderDraftScope, postreeveId: string, ref?: ProviderDraftRef): Promise<void> {
    this.#assertDraftScope(scope);
    if (ref?.kind === "gmail") throw new Error("IMAP cannot remove a draft reference from another provider");
    await this.#withClient(async (client) => {
      const mailbox = await findDraftsMailbox(client);
      const opened = await client.mailboxOpen(mailbox);
      const matches = (await this.#listSelectedProviderDrafts(
        client,
        mailbox,
        opened,
        scope,
        client.capabilities.has("UIDPLUS"),
      ))
        .filter((draft) => draft.postreeveId === postreeveId);
      const uids = new Set(matches.map(({ ref: candidate }) => candidate.kind === "imap" ? candidate.uid : 0));
      if (ref?.kind === "imap" && !uids.has(ref.uid)) {
        const exact = await this.#resolveExactProviderDraft(
          client,
          mailbox,
          opened,
          scope,
          postreeveId,
          ref,
          client.capabilities.has("UIDPLUS"),
        );
        if (exact) uids.add(ref.uid);
      }
      const selected = [...uids].filter((uid) => uid > 0);
      await retireDraftUids(client, selected);
      const remaining = (await this.#listSelectedProviderDrafts(client, mailbox, opened, scope))
        .some((draft) => draft.postreeveId === postreeveId);
      if (remaining) throw new Error("IMAP server refused to remove the provider draft");
    });
  }

  async listMessages(accountId: string, mailbox: string, limit: number): Promise<MessageSummary[]> {
    return (await this.listMessagePage(accountId, mailbox, limit)).messages;
  }

  async listMessagePage(accountId: string, mailbox: string, limit: number): Promise<MailboxPage> {
    this.#assertAccount(accountId);
    assertLimit(limit);
    return this.#withClient(async (client) => {
      const opened = await client.mailboxOpen(mailbox, { readOnly: true });
      const selected = await searchUids(client, { all: true }, limit + 1);
      const messages = selected.length === 0
        ? []
        : await this.#fetchSummaries(client, opened, selected.slice(0, limit));
      return { messages, complete: selected.length <= limit };
    });
  }

  async readMessages(accountId: string, references: MessageRef[]): Promise<ProviderMessageDetail[]> {
    this.#assertAccount(accountId);
    for (const reference of references) this.#assertReference(reference);

    return this.#withClient(async (client) => {
      const details: ProviderMessageDetail[] = [];
      for (const [mailbox, mailboxReferences] of groupByMailbox(references)) {
        const opened = await client.mailboxOpen(mailbox, { readOnly: true });
        for (const reference of mailboxReferences) {
          assertUidValidity(opened, reference);
          const message = await client.fetchOne(
            reference.uid,
            { uid: true, flags: true, envelope: true, internalDate: true, headers: true, bodyStructure: true },
            { uid: true },
          );
          assertCurrentMessage(message, reference);
          if (!message.headers || !message.bodyStructure) {
            throw new Error(`Message ${reference.uid} has no readable MIME structure`);
          }
          const parsedHeaders = await parseMessage(message.headers);
          const rendered = await renderImapBody(client, {
            kind: "imap",
            mailbox,
            uidValidity: opened.uidValidity.toString(),
            uid: reference.uid,
            part: "root",
          }, message.bodyStructure);
          details.push(toDetail(this.#config.accountId, mailbox, opened, message, parsedHeaders, rendered));
        }
      }
      return details;
    });
  }

  async downloadAttachment(
    accountId: string,
    locator: ProviderAttachmentLocator,
    maxBytes: number,
  ): Promise<ProviderAttachmentDownload> {
    this.#assertAccount(accountId);
    if (locator.kind !== "imap") throw new Error("IMAP cannot download another provider's attachment");
    return this.#withClient(async (client) => {
      const opened = await client.mailboxOpen(locator.mailbox, { readOnly: true });
      if (opened.uidValidity.toString() !== locator.uidValidity) throw new Error("IMAP attachment reference is stale");
      const message = await client.fetchOne(locator.uid, { uid: true, bodyStructure: true }, { uid: true });
      if (!message || message.uid !== locator.uid || !message.bodyStructure) {
        throw new Error("IMAP attachment reference is stale");
      }
      const attachment = imapAttachments(locator, message.bodyStructure)
        .find(({ locator: candidate }) => candidate.kind === "imap" && candidate.part === locator.part);
      if (!attachment) throw new Error("IMAP attachment reference is stale");
      const part = visibleImapParts(message.bodyStructure)
        .find((candidate) => candidate.section === locator.part && isFileNode(candidate.node));
      if (!part) throw new Error("IMAP attachment reference is stale");
      const content = await downloadImapAttachmentBytes(client, locator.uid, part, maxBytes);
      return { filename: attachment.filename, mediaType: attachment.mediaType, content };
    });
  }

  async searchMessages(
    accountId: string,
    mailbox: string,
    query: string,
    limit: number,
  ): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    assertLimit(limit);
    const trimmedQuery = query.trim();

    return this.#withClient(async (client) => {
      const opened = await client.mailboxOpen(mailbox, { readOnly: true });
      const criteria: SearchObject = trimmedQuery
        ? {
            or: [
              { subject: trimmedQuery },
              { from: trimmedQuery },
              { to: trimmedQuery },
              { text: trimmedQuery },
            ],
          }
        : { all: true };
      const selected = await searchUids(client, criteria, limit);
      if (selected.length === 0) return [];
      return this.#fetchSummaries(client, opened, selected);
    });
  }

  async revalidate(reference: MessageRef): Promise<boolean> {
    this.#assertReference(reference);
    return this.#withClient(async (client) => {
      const opened = await client.mailboxOpen(reference.mailbox, { readOnly: true });
      if (opened.uidValidity.toString() !== reference.uidValidity) return false;
      const message = await client.fetchOne(reference.uid, { uid: true }, { uid: true });
      return isCurrentMessage(message, reference);
    });
  }

  async apply(reference: MessageRef, action: TriageAction): Promise<AppliedMailAction> {
    this.#assertReference(reference);
    return this.#withClient(async (client) => {
      const opened = await client.mailboxOpen(reference.mailbox);
      assertUidValidity(opened, reference);
      const before = await client.fetchOne(reference.uid, { uid: true, flags: true }, { uid: true });
      assertCurrentMessage(before, reference);

      const previous = referenceFor(this.#config.accountId, reference.mailbox, opened, before);
      const previousRead = hasFlag(before.flags, SEEN_FLAG);

      switch (action.type) {
        case "leave":
          return { current: previous, previous, action, previousRead };
        case "mark_read":
          await changeSeenFlag(client, reference, true);
          return {
            current: await fetchCurrentReference(client, this.#config.accountId, reference.mailbox, opened, reference.uid),
            previous,
            action,
            previousRead,
          };
        case "mark_unread":
          await changeSeenFlag(client, reference, false);
          return {
            current: await fetchCurrentReference(client, this.#config.accountId, reference.mailbox, opened, reference.uid),
            previous,
            action,
            previousRead,
          };
        case "move":
          return this.#move(client, reference, opened, action.destination, action, previous, previousRead);
        case "trash": {
          const destination = await findTrashMailbox(client);
          return this.#move(client, reference, opened, destination, action, previous, previousRead);
        }
      }
    });
  }

  async undo(applied: AppliedMailAction): Promise<ProviderLocationMove | null> {
    this.#assertReference(applied.current);
    this.#assertReference(applied.previous);
    if (applied.current.accountId !== applied.previous.accountId) {
      throw new Error("Cannot undo an action across accounts");
    }

    return this.#withClient(async (client) => {
      switch (applied.action.type) {
        case "leave":
          return null;
        case "mark_read":
        case "mark_unread": {
          const opened = await client.mailboxOpen(applied.current.mailbox);
          assertUidValidity(opened, applied.current);
          const current = await client.fetchOne(applied.current.uid, { uid: true }, { uid: true });
          assertCurrentMessage(current, applied.current);
          await changeSeenFlag(client, applied.current, applied.previousRead);
          return null;
        }
        case "move":
        case "trash": {
          const destination = await client.status(applied.previous.mailbox, { uidValidity: true });
          if (destination.uidValidity?.toString() !== applied.previous.uidValidity) {
            throw new Error(`Mailbox ${applied.previous.mailbox} changed since the action was applied`);
          }
          const opened = await client.mailboxOpen(applied.current.mailbox);
          assertUidValidity(opened, applied.current);
          const current = await client.fetchOne(applied.current.uid, { uid: true }, { uid: true });
          assertCurrentMessage(current, applied.current);
          const previous = referenceFor(this.#config.accountId, applied.current.mailbox, opened, current);
          const moved = await client.messageMove(applied.current.uid, applied.previous.mailbox, { uid: true });
          if (!moved) throw new Error(`IMAP server refused to undo the move of UID ${applied.current.uid}`);
          const movedIdentity = movedIdentityFor(moved, applied.current.uid);
          if (destination.uidValidity !== movedIdentity.uidValidity) {
            throw new Error(`IMAP server returned inconsistent UIDVALIDITY for ${applied.previous.mailbox}`);
          }
          return {
            previous,
            current: {
              accountId: this.#config.accountId,
              mailbox: applied.previous.mailbox,
              uidValidity: movedIdentity.uidValidity.toString(),
              uid: movedIdentity.uid,
              modseq: null,
            },
          };
        }
      }
    });
  }

  async #replaceDraft(
    client: ImapClient,
    scope: ProviderDraftScope,
    draft: Draft,
    ref?: Extract<ProviderDraftRef, { kind: "imap" }>,
  ): Promise<ProviderDraftRef> {
    const mailbox = await findDraftsMailbox(client);
    let priorMatches: ListedProviderDraft[] = [];
    if (ref) {
      const opened = await client.mailboxOpen(mailbox);
      priorMatches = (await this.#listSelectedProviderDrafts(client, mailbox, opened, scope))
        .filter((candidate) => candidate.postreeveId === draft.id);
      if (!priorMatches.some((candidate) => candidate.ref.kind === "imap" && candidate.ref.uid === ref.uid)) {
        const exact = await this.#resolveExactProviderDraft(
          client,
          mailbox,
          opened,
          scope,
          draft.id,
          ref,
          false,
        );
        if (exact) priorMatches.push(exact);
      }
    }
    let appended: AppendResponseObject | false;
    let appendError: unknown;
    try {
      appended = await client.append(mailbox, await buildProviderDraftMessage(scope, draft), [DRAFT_FLAG], new Date(draft.updatedAt));
    } catch (error) {
      appended = false;
      appendError = error;
    }
    const opened = await client.mailboxOpen(mailbox);
    const discovered = (await this.#listSelectedProviderDrafts(
      client,
      mailbox,
      opened,
      scope,
      client.capabilities.has("UIDPLUS"),
    ))
      .filter((candidate) => candidate.postreeveId === draft.id);
    const currentUidValidity = opened.uidValidity.toString();
    const currentGenerationPriorMatches = priorMatches.filter(({ ref: candidate }) =>
      candidate.kind === "imap"
      && candidate.mailbox === mailbox
      && candidate.uidValidity === currentUidValidity);
    const discoveredUids = new Set(discovered.flatMap(({ ref: candidate }) =>
      candidate.kind === "imap" ? [candidate.uid] : []));
    const matches = [
      ...discovered,
      ...currentGenerationPriorMatches.filter(({ ref: candidate }) =>
        candidate.kind === "imap" && !discoveredUids.has(candidate.uid)),
    ];
    const appendedCurrent = appended && appended.uid !== undefined && appended.uidValidity !== undefined
      ? matches.find(({ deleted, ref }) => !deleted && ref.kind === "imap" && ref.uid === appended.uid
        && ref.uidValidity === appended.uidValidity?.toString())
      : undefined;
    const current = appendedCurrent
      ?? matches.find((candidate) => !candidate.deleted && candidate.version === draft.version);
    if (!current) {
      if (appendError) throw appendError;
      throw new Error("IMAP appended a draft but its Postreeve marker could not be found");
    }
    if (current.ref.kind !== "imap") throw new Error("IMAP listed a draft reference from another provider");
    const currentUid = current.ref.uid;
    const staleUids = matches
      .filter(({ ref }) => ref.kind === "imap" && ref.uid !== currentUid)
      .map(({ ref }) => ref.kind === "imap" ? ref.uid : 0)
      .filter((uid) => uid > 0);
    await retireDraftUids(client, staleUids);
    const activeCopies = (await this.#listSelectedProviderDrafts(client, mailbox, opened, scope))
      .filter((candidate) => candidate.postreeveId === draft.id);
    if (activeCopies.length !== 1 || activeCopies[0]?.ref.kind !== "imap"
      || activeCopies[0].ref.uid !== currentUid) {
      throw new Error("IMAP stored the current draft but refused to remove stale copies");
    }
    return current.ref;
  }

  async #resolveExactProviderDraft(
    client: ImapClient,
    mailbox: string,
    opened: MailboxObject,
    scope: ProviderDraftScope,
    postreeveId: string,
    ref: Extract<ProviderDraftRef, { kind: "imap" }>,
    allowDeleted: boolean,
  ): Promise<ListedProviderDraft | null> {
    if (ref.mailbox !== mailbox || ref.uidValidity !== opened.uidValidity.toString()) return null;
    const exact = await client.fetchOne(
      ref.uid,
      { uid: true, flags: true, headers: providerDraftMarkerHeaders },
      { uid: true },
    );
    if (!exact) {
      if (await exactUidExists(client, ref.uid)) {
        throw new Error(`IMAP could not read existing draft UID ${ref.uid}`);
      }
      return null;
    }
    if (exact.uid !== ref.uid) {
      throw new Error(`IMAP returned the wrong UID while resolving draft UID ${ref.uid}`);
    }
    if (!exact.flags || !exact.headers) {
      throw new Error(`IMAP returned incomplete data while resolving draft UID ${ref.uid}`);
    }
    const deleted = hasFlag(exact.flags, DELETED_FLAG);
    const markers = parseProviderDraftMarkers(exact.headers);
    if (!hasFlag(exact.flags, DRAFT_FLAG)
      || (deleted && !allowDeleted)
      || markers?.tenantId !== scope.tenantId
      || markers.accountId !== scope.accountId
      || markers.postreeveId !== postreeveId) return null;
    return {
      ...markers,
      deleted,
      ref: {
        kind: "imap",
        mailbox,
        uidValidity: opened.uidValidity.toString(),
        uid: exact.uid,
      },
    };
  }

  async #listProviderDrafts(client: ImapClient, scope: ProviderDraftScope): Promise<ProviderDraft[]> {
    const mailbox = await findDraftsMailbox(client);
    const opened = await client.mailboxOpen(mailbox, { readOnly: true });
    return (await this.#listSelectedProviderDrafts(client, mailbox, opened, scope))
      .map(({ deleted: _deleted, ...draft }) => draft);
  }

  async #listSelectedProviderDrafts(
    client: ImapClient,
    mailbox: string,
    opened: MailboxObject,
    scope: ProviderDraftScope,
    includeDeleted = false,
  ): Promise<ListedProviderDraft[]> {
    const selected = await searchUids(
      client,
      includeDeleted ? { draft: true } : { draft: true, deleted: false },
      MAX_PROVIDER_DRAFTS + 1,
    );
    if (selected.length > MAX_PROVIDER_DRAFTS) throw new Error("IMAP draft reconciliation exceeded its bound");
    const drafts: ListedProviderDraft[] = [];
    const remaining = new Set(selected);
    for await (const message of client.fetch(
      selected,
      { uid: true, flags: true, headers: providerDraftMarkerHeaders },
      { uid: true },
    )) {
      if (!remaining.delete(message.uid)) {
        throw new Error(`IMAP returned unexpected draft UID ${message.uid}`);
      }
      if (!message.flags || !message.headers) {
        throw new Error(`IMAP returned incomplete data for draft UID ${message.uid}`);
      }
      const deleted = hasFlag(message.flags, DELETED_FLAG);
      if (!hasFlag(message.flags, DRAFT_FLAG) || (!includeDeleted && deleted)) continue;
      const markers = parseProviderDraftMarkers(message.headers);
      if (!markers || markers.tenantId !== scope.tenantId || markers.accountId !== scope.accountId) continue;
      drafts.push({
        ...markers,
        deleted,
        ref: {
          kind: "imap",
          mailbox,
          uidValidity: opened.uidValidity.toString(),
          uid: message.uid,
        },
      });
    }
    if (remaining.size > 0) {
      throw new Error("IMAP did not return every selected provider draft");
    }
    return drafts;
  }

  async #move(
    client: ImapClient,
    reference: MessageRef,
    sourceMailbox: MailboxObject,
    destination: string,
    action: TriageAction,
    previous: MessageRef,
    previousRead: boolean,
  ): Promise<AppliedMailAction> {
    if (destination === reference.mailbox) {
      return { current: previous, previous, action, previousRead };
    }
    if (!client.capabilities.has("UIDPLUS")) {
      throw new Error("This IMAP server cannot safely identify a moved message because it does not support UIDPLUS");
    }

    // The fetch and UID MOVE share one selected mailbox, and UNCHANGEDSINCE is
    // unavailable for MOVE. Fetch once more immediately before the mutation.
    const current = await client.fetchOne(reference.uid, { uid: true }, { uid: true });
    assertCurrentMessage(current, reference);
    const moved = await client.messageMove(reference.uid, destination, { uid: true });
    if (!moved) throw new Error(`IMAP server refused to move UID ${reference.uid}`);

    const movedIdentity = movedIdentityFor(moved, reference.uid);
    const destinationMailbox = await client.mailboxOpen(destination, { readOnly: true });
    if (destinationMailbox.uidValidity !== movedIdentity.uidValidity) {
      throw new Error(`IMAP server returned inconsistent UIDVALIDITY for ${destination}`);
    }
    const after = await client.fetchOne(movedIdentity.uid, { uid: true }, { uid: true });
    if (!after) throw new Error(`Moved message UID ${movedIdentity.uid} is missing from ${destination}`);

    return {
      current: referenceFor(this.#config.accountId, destination, destinationMailbox, after),
      previous: referenceFor(this.#config.accountId, reference.mailbox, sourceMailbox, current),
      action,
      previousRead,
    };
  }

  async #fetchSummaries(
    client: ImapClient,
    mailbox: MailboxObject,
    uids: number[],
  ): Promise<MessageSummary[]> {
    const summaries: MessageSummary[] = [];
    for await (const message of client.fetch(
      uids,
      {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        headers: ["Message-ID", "In-Reply-To", "References"],
        source: { maxLength: SUMMARY_SOURCE_BYTES },
      },
      { uid: true },
    )) {
      const parsed = message.source ? await parseMessage(message.source) : undefined;
      const threadingHeaders = message.headers ? await parseMessage(message.headers) : undefined;
      summaries.push(toSummary(this.#config.accountId, mailbox.path, mailbox, message, parsed, threadingHeaders));
    }

    const order = new Map(uids.map((uid, index) => [uid, index]));
    summaries.sort((left, right) => (order.get(left.ref.uid) ?? 0) - (order.get(right.ref.uid) ?? 0));
    return summaries;
  }

  async #withClient<T>(operation: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = this.#createClient({
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.secure,
      auth: { user: this.#config.username, pass: this.#config.password },
      logger: false,
      qresync: true,
    });

    let connected = false;
    try {
      await client.connect();
      connected = true;
      return await operation(client);
    } finally {
      if (!connected) {
        client.close();
      } else {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }
    }
  }

  #assertAccount(accountId: string): void {
    if (accountId !== this.#config.accountId) {
      throw new Error(`IMAP provider for ${this.#config.accountId} cannot access account ${accountId}`);
    }
  }

  #assertDraftScope(scope: ProviderDraftScope, draft?: Draft): void {
    this.#assertAccount(scope.accountId);
    if (!scope.tenantId.trim()) throw new Error("A tenant ID is required for provider drafts");
    if (draft) this.#assertAccount(draft.accountId);
  }

  #assertReference(reference: MessageRef): void {
    this.#assertAccount(reference.accountId);
  }
}

async function retireDraftUids(client: ImapClient, uids: readonly number[]): Promise<void> {
  if (uids.length === 0) return;
  if (client.capabilities.has("UIDPLUS")) {
    for (const uid of uids) {
      await client.messageDelete(uid, { uid: true });
      if (await exactUidExists(client, uid)) {
        throw new Error(`IMAP server did not confirm selective removal of draft UID ${uid}`);
      }
    }
    return;
  }
  for (const uid of uids) {
    const deleted = await client.messageFlagsAdd(uid, [DELETED_FLAG], { uid: true });
    if (!deleted) {
      const current = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true });
      if ((!current && await exactUidExists(client, uid))
        || (current && !hasFlag(current.flags, DELETED_FLAG))) {
        throw new Error(`IMAP server did not confirm marking draft UID ${uid} deleted`);
      }
    }
  }
}

async function exactUidExists(client: ImapClient, uid: number): Promise<boolean> {
  const result = await client.search({ uid }, { uid: true, returnOptions: ["ALL"] });
  if (result === false) {
    throw new Error(`IMAP server could not confirm whether draft UID ${uid} exists`);
  }
  if (Array.isArray(result)) return result.length > 0;
  return newestUidsFromSequenceSet(result.all, 2).length > 0;
}

async function findDraftsMailbox(client: ImapClient): Promise<string> {
  const mailboxes = await client.list();
  const drafts = mailboxes.find((mailbox) => specialUseFor(mailbox) === "drafts" && !hasFlag(mailbox.flags, "\\Noselect"));
  if (!drafts) throw new Error("This account has no discoverable special-use Drafts mailbox");
  return drafts.path;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Message limit must be a positive integer");
}

function assertUidValidity(mailbox: MailboxObject, reference: MessageRef): void {
  if (mailbox.uidValidity.toString() !== reference.uidValidity) {
    throw new Error(`Mailbox ${reference.mailbox} changed since the message was listed`);
  }
}

function assertCurrentMessage(message: FetchMessageObject | false, reference: MessageRef): asserts message is FetchMessageObject {
  if (!isCurrentMessage(message, reference)) {
    throw new Error(`Message UID ${reference.uid} is missing or stale in ${reference.mailbox}`);
  }
}

function isCurrentMessage(message: FetchMessageObject | false, reference: MessageRef): message is FetchMessageObject {
  if (!message || message.uid !== reference.uid) return false;
  if (reference.modseq === null) return true;
  return message.modseq?.toString() === reference.modseq;
}

async function changeSeenFlag(client: ImapClient, reference: MessageRef, read: boolean): Promise<void> {
  // ImapFlow 1.7.6 places UNCHANGEDSINCE after the flag data, which strict IMAP
  // servers reject. apply() and undo() validate the UID and MODSEQ immediately
  // before this single-flag mutation, so the stale-message guard remains intact.
  const options = { uid: true as const };
  const changed = read
    ? await client.messageFlagsAdd(reference.uid, [SEEN_FLAG], options)
    : await client.messageFlagsRemove(reference.uid, [SEEN_FLAG], options);
  if (!changed) throw new Error(`IMAP server refused to update UID ${reference.uid}`);
}

async function fetchCurrentReference(
  client: ImapClient,
  accountId: string,
  mailboxPath: string,
  mailbox: MailboxObject,
  uid: number,
): Promise<MessageRef> {
  const message = await client.fetchOne(uid, { uid: true }, { uid: true });
  if (!message) throw new Error(`Message UID ${uid} disappeared after its flags changed`);
  return referenceFor(accountId, mailboxPath, mailbox, message);
}

function movedIdentityFor(moved: CopyResponseObject, sourceUid: number): { uidValidity: bigint; uid: number } {
  const uid = moved.uidMap?.get(sourceUid);
  if (moved.uidValidity === undefined || uid === undefined) {
    throw new Error("IMAP server did not return the UID of the moved message");
  }
  return { uidValidity: moved.uidValidity, uid };
}

async function findTrashMailbox(client: ImapClient): Promise<string> {
  const mailboxes = await client.list();
  const trash = mailboxes.find((mailbox) => specialUseFor(mailbox) === "trash");
  if (!trash) throw new Error("This account has no discoverable special-use Trash mailbox");
  return trash.path;
}

function specialUseFor(mailbox: Pick<ListResponse, "path" | "specialUse">): Folder["specialUse"] {
  if (mailbox.path.toUpperCase() === "INBOX") return "inbox";
  switch (mailbox.specialUse?.toLowerCase()) {
    case "\\sent":
      return "sent";
    case "\\drafts":
      return "drafts";
    case "\\trash":
      return "trash";
    case "\\junk":
      return "junk";
    case "\\archive":
    case "\\all":
      return "archive";
    default:
      return null;
  }
}

async function manageableMailbox(
  client: ImapClient,
  path: string,
  includeStatus = false,
): Promise<ListResponse> {
  const mailboxes = await client.list(includeStatus ? { statusQuery: { messages: true } } : undefined);
  const mailbox = mailboxes.find((candidate) => candidate.path === path);
  if (!mailbox || hasFlag(mailbox.flags, "\\Noselect")) throw new Error(`Folder ${path} does not exist`);
  if (specialUseFor(mailbox) !== null) throw new Error("System and special-use folders cannot be changed");
  return mailbox;
}

function renamedMailboxPath(mailbox: ListResponse, name: string): string {
  if (!mailbox.delimiter) return name;
  const separator = mailbox.path.lastIndexOf(mailbox.delimiter);
  return separator < 0 ? name : `${mailbox.path.slice(0, separator + mailbox.delimiter.length)}${name}`;
}

function newestUids(uids: number[], limit: number): number[] {
  return [...uids].sort((left, right) => right - left).slice(0, limit);
}

async function searchUids(client: ImapClient, query: SearchObject, limit: number): Promise<number[]> {
  const result = await client.search(query, { uid: true, returnOptions: ["ALL"] });
  if (result === false) throw new Error("IMAP server could not complete the UID search");
  if (Array.isArray(result)) return newestUids(result, limit);
  return newestUidsFromSequenceSet(result.all, limit);
}

function newestUidsFromSequenceSet(sequenceSet: string | undefined, limit: number): number[] {
  if (!sequenceSet?.trim()) return [];

  const candidates = new Set<number>();
  for (const rawPart of sequenceSet.split(",")) {
    const match = /^(\d+)(?::(\d+))?$/.exec(rawPart.trim());
    if (!match) throw new Error("IMAP server returned an invalid UID search result");

    const first = Number(match[1]);
    const second = Number(match[2] ?? match[1]);
    if (!isUid(first) || !isUid(second)) {
      throw new Error("IMAP server returned an invalid UID search result");
    }

    const high = Math.max(first, second);
    const low = Math.min(first, second);
    for (let uid = high, added = 0; uid >= low && added < limit; uid -= 1, added += 1) {
      candidates.add(uid);
    }
  }

  return newestUids([...candidates], limit);
}

function isUid(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 0xffff_ffff;
}

function groupByMailbox(references: MessageRef[]): Map<string, MessageRef[]> {
  const grouped = new Map<string, MessageRef[]>();
  for (const reference of references) {
    const mailbox = grouped.get(reference.mailbox);
    if (mailbox) mailbox.push(reference);
    else grouped.set(reference.mailbox, [reference]);
  }
  return grouped;
}

async function parseMessage(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source, {
    skipTextToHtml: true,
  });
}

function toSummary(
  accountId: string,
  mailboxPath: string,
  mailbox: MailboxObject,
  message: FetchMessageObject,
  parsed?: ParsedMail,
  threadingHeaders?: ParsedMail,
): ProviderMessageSummary {
  const canonicalReceivedAt = [message.internalDate, message.envelope?.date, parsedDate(parsed)]
    .map(toDate)
    .find((date): date is Date => date !== undefined)
    ?.toISOString() ?? null;
  const deliveredTo = deliveryAddresses(parsed);
  const threading = threadingHeaders ?? parsed;
  const rawMessageIds = rawHeaderValues(threading, "message-id");
  const rawInReplyTo = rawHeaderValues(threading, "in-reply-to");
  const rawReferences = rawHeaderValues(threading, "references");
  const identification = normalizeIdentificationFields({
    messageId: rawMessageIds.length > 0 || !message.envelope?.messageId
      ? rawMessageIds
      : [message.envelope.messageId],
    inReplyTo: rawInReplyTo.length > 0 || !message.envelope?.inReplyTo
      ? rawInReplyTo
      : [message.envelope.inReplyTo],
    references: rawReferences,
  });
  return {
    ref: referenceFor(accountId, mailboxPath, mailbox, message),
    messageId: identification.messageId ?? "",
    inReplyTo: identification.inReplyTo,
    references: identification.references,
    referenceSequences: normalizeReferenceSequences(rawReferences),
    subject: message.envelope?.subject ?? parsed?.subject ?? "(no subject)",
    from: message.envelope?.from?.map(toEnvelopeAddress) ?? parsedAddresses(parsed?.from?.value),
    replyTo: message.envelope?.replyTo?.map(toEnvelopeAddress) ?? parsedAddresses(flattenAddresses(parsed?.replyTo)),
    to: message.envelope?.to?.map(toEnvelopeAddress) ?? parsedAddresses(flattenAddresses(parsed?.to)),
    cc: message.envelope?.cc?.map(toEnvelopeAddress) ?? parsedAddresses(flattenAddresses(parsed?.cc)),
    ...(deliveredTo.length === 0 ? {} : { deliveredTo }),
    canonicalReceivedAt,
    receivedAt: canonicalReceivedAt ?? new Date(0).toISOString(),
    preview: previewFor(parsed?.text),
    read: hasFlag(message.flags, SEEN_FLAG),
    flagged: hasFlag(message.flags, "\\Flagged"),
  };
}

const deliveryHeaderNames = new Set(["delivered-to", "x-original-to", "envelope-to"]);
const emailAddressPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

function deliveryAddresses(parsed: ParsedMail | undefined): string[] {
  if (!parsed) return [];
  const addresses = new Set<string>();
  for (const header of parsed.headerLines) {
    if (!deliveryHeaderNames.has(header.key.toLowerCase())) continue;
    const separator = header.line.indexOf(":");
    const value = separator === -1 ? header.line : header.line.slice(separator + 1);
    for (const match of value.matchAll(emailAddressPattern)) addresses.add(match[0].toLowerCase());
  }
  return [...addresses];
}

function toDetail(
  accountId: string,
  mailboxPath: string,
  mailbox: MailboxObject,
  message: FetchMessageObject,
  parsed: ParsedMail,
  rendered: { text: string; html: string | null; attachments: ProviderAttachment[] },
): ProviderMessageDetail {
  return {
    ...toSummary(accountId, mailboxPath, mailbox, message, parsed),
    ...rendered,
  };
}

async function renderImapBody(
  client: ImapClient,
  location: Extract<ProviderAttachmentLocator, { kind: "imap" }>,
  root: MessageStructureObject,
): Promise<{ text: string; html: string | null; attachments: ProviderAttachment[] }> {
  const body = await readImapText(client, location.uid, root);
  const cids = referencedCids(body.html);
  let html = body.html;
  if (html) {
    for (const { node: part, section } of visibleImapParts(root)) {
      const cid = normalizedCid(part.id);
      if (!section || !cid || !cids.has(cid) || !safeAttachmentMediaType(part.type).startsWith("image/")) continue;
      const downloaded = await client.download(location.uid, section, { uid: true });
      const content = await readableBytes(downloaded.content);
      html = replaceCid(html, cid, `data:${safeAttachmentMediaType(part.type)};base64,${content.toString("base64")}`);
    }
  }
  return {
    ...body,
    html,
    attachments: imapAttachments(location, root),
  };
}

async function readImapText(
  client: ImapClient,
  uid: number,
  root: MessageStructureObject,
): Promise<{ text: string; html: string | null }> {
  const plain: string[] = [];
  const html: string[] = [];
  for (const { node: part, section } of visibleImapParts(root)) {
    const mediaType = safeAttachmentMediaType(part.type);
    if (!section || (mediaType !== "text/plain" && mediaType !== "text/html") || isFileNode(part)) continue;
    const downloaded = await client.download(uid, section, { uid: true });
    const value = (await readableBytes(downloaded.content)).toString("utf8").replace(/\r?\n/g, "\n");
    if (mediaType === "text/plain") plain.push(value);
    else html.push(value);
  }
  return { text: plain.join("\n"), html: html.length > 0 ? html.join("<br/>\n") : null };
}

function imapAttachments(
  location: Extract<ProviderAttachmentLocator, { kind: "imap" }>,
  root: MessageStructureObject,
): ProviderAttachment[] {
  return visibleImapParts(root).flatMap(({ node: part, section }) => {
    if (!section || !isFileNode(part)) return [];
    return [{
      locator: { ...location, part: section },
      filename: safeAttachmentFilename(imapFilename(part) ?? "attachment"),
      mediaType: safeAttachmentMediaType(part.type),
      size: estimatedDecodedSize(part),
      sizeIsEstimate: true,
    }];
  });
}

interface VisibleImapPart {
  readonly node: MessageStructureObject;
  readonly section: string | null;
}

function visibleImapParts(root: MessageStructureObject): VisibleImapPart[] {
  const result: VisibleImapPart[] = [];
  const pending = [{ node: root, root: true }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    result.push({ node: current.node, section: current.node.part ?? (current.root ? "1" : null) });
    if (!isFileNode(current.node)) {
      pending.push(...(current.node.childNodes ?? []).toReversed().map((node) => ({ node, root: false })));
    }
  }
  return result;
}

function imapFilename(part: MessageStructureObject): string | undefined {
  return part.dispositionParameters?.filename ?? part.parameters?.name;
}

function isFileNode(part: MessageStructureObject): boolean {
  return Boolean(imapFilename(part)?.trim() || part.disposition?.toLowerCase() === "attachment");
}

function estimatedDecodedSize(part: MessageStructureObject): number {
  const encoded = part.size ?? 0;
  return part.encoding?.toLowerCase() === "base64" ? Math.floor(encoded / 4) * 3 : encoded;
}

async function downloadImapAttachmentBytes(
  client: ImapClient,
  uid: number,
  part: VisibleImapPart,
  maxBytes: number,
): Promise<Buffer> {
  if (!part.section) throw new Error("IMAP attachment has no part identifier");
  const encoding = part.node.encoding?.toLowerCase() ?? "";
  const binary = client.capabilities.has("BINARY");
  const encodedLimit = encoding === "quoted-printable"
    ? (maxBytes + 1) * 4
    : encoding === "base64"
      ? (maxBytes + 1) * 2
      : maxBytes + 1;
  const fetchLimit = binary ? maxBytes + 1 : encodedLimit;
  if (!binary && part.node.size !== undefined && part.node.size > encodedLimit) {
    throw new Error(`Attachment exceeds the ${maxBytes}-byte download limit`);
  }
  const response = await client.fetchOne(
    uid,
    { uid: true, bodyParts: [{ key: part.node.part ?? "TEXT", start: 0, maxLength: fetchLimit }] },
    { uid: true, binary: true },
  );
  const fetchSection = part.node.part ?? "TEXT";
  const encoded = response && response.bodyParts?.get(fetchSection);
  if (!response || response.uid !== uid || !encoded) throw new Error("IMAP attachment reference is stale");
  const content = response.binaryParts?.has(fetchSection)
    ? encoded
    : decodeTransferEncoding(encoded, encoding);
  if (content.byteLength > maxBytes || encoded.byteLength >= fetchLimit) {
    throw new Error(`Attachment exceeds the ${maxBytes}-byte download limit`);
  }
  return content;
}

function decodeTransferEncoding(content: Buffer, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(content.toString("ascii").replace(/\s/g, ""), "base64");
  if (encoding !== "quoted-printable") return content;
  const bytes: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x3d) {
      bytes.push(content[index]!);
      continue;
    }
    if (content[index + 1] === 0x0d && content[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    if (content[index + 1] === 0x0a) {
      index += 1;
      continue;
    }
    const hex = content.subarray(index + 1, index + 3).toString("ascii");
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(0x3d);
    }
  }
  return Buffer.from(bytes);
}

async function readableBytes(stream: DownloadObject["content"]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function normalizedCid(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return normalized || null;
}

function referencedCids(html: string | null): Set<string> {
  const result = new Set<string>();
  for (const match of html?.matchAll(/\bcid:([^'"\s>]+)/gi) ?? []) {
    try {
      result.add(decodeURIComponent(match[1]!).toLowerCase());
    } catch {
      result.add(match[1]!.toLowerCase());
    }
  }
  return result;
}

function replaceCid(html: string, cid: string, replacement: string): string {
  return html.replace(/\bcid:([^'"\s>]+)/gi, (match, value: string) => {
    try {
      return decodeURIComponent(value).toLowerCase() === cid ? replacement : match;
    } catch {
      return value.toLowerCase() === cid ? replacement : match;
    }
  });
}

function referenceFor(
  accountId: string,
  mailboxPath: string,
  mailbox: Pick<MailboxObject, "uidValidity">,
  message: Pick<FetchMessageObject, "uid" | "modseq">,
): MessageRef {
  return {
    accountId,
    mailbox: mailboxPath,
    uidValidity: mailbox.uidValidity.toString(),
    uid: message.uid,
    modseq: message.modseq?.toString() ?? null,
  };
}

function hasFlag(flags: Set<string> | undefined, expected: string): boolean {
  if (!flags) return false;
  const normalized = expected.toLowerCase();
  for (const flag of flags) {
    if (flag.toLowerCase() === normalized) return true;
  }
  return false;
}

function toEnvelopeAddress(address: { name?: string; address?: string }): MessageSummary["from"][number] {
  return { name: address.name ?? "", address: address.address ?? "" };
}

function parsedAddresses(addresses: EmailAddress[] | undefined): MessageSummary["from"] {
  return (addresses ?? []).map((address) => ({ name: address.name, address: address.address ?? "" }));
}

function flattenAddresses(value: ParsedMail["to"]): EmailAddress[] {
  if (!value) return [];
  return Array.isArray(value) ? value.flatMap((address) => address.value) : value.value;
}

function parsedDate(parsed: ParsedMail | undefined): string | undefined {
  const header = parsed?.headerLines.find(({ key }) => key.toLowerCase() === "date")?.line;
  if (!header) return undefined;
  const separator = header.indexOf(":");
  return separator < 0 ? undefined : header.slice(separator + 1).trim();
}

function rawHeaderValues(parsed: ParsedMail | undefined, name: string): string[] {
  return (parsed?.headerLines ?? [])
    .filter(({ key }) => key.toLowerCase() === name)
    .flatMap(({ line }) => {
      const separator = line.indexOf(":");
      return separator < 0 ? [] : [line.slice(separator + 1).trim()];
    });
}

function previewFor(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
