import {
  ImapFlow,
  type CopyResponseObject,
  type FetchOptions,
  type FetchQueryObject,
  type FetchMessageObject,
  type ImapFlowOptions,
  type ListOptions,
  type ListResponse,
  type MailboxObject,
  type MailboxOpenOptions,
  type SearchObject,
  type StatusObject,
  type StoreOptions,
} from "imapflow";
import { simpleParser, type EmailAddress, type ParsedMail } from "mailparser";

import type {
  Folder,
  MessageDetail,
  MessageRef,
  MessageSummary,
  TriageAction,
} from "../../shared/contracts";
import type { AppliedMailAction, MailProvider } from "./provider";

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
  mailboxOpen(path: string | string[], options?: MailboxOpenOptions): Promise<MailboxObject>;
  status(
    path: string | string[],
    query: { uidValidity?: boolean },
  ): Promise<StatusObject>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;
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
}

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClient;

const SUMMARY_SOURCE_BYTES = 64 * 1024;
const SEEN_FLAG = "\\Seen";

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

  async listMessages(accountId: string, mailbox: string, limit: number): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    assertLimit(limit);
    return this.#withClient(async (client) => {
      const opened = await client.mailboxOpen(mailbox, { readOnly: true });
      const uids = await client.search({ all: true }, { uid: true });
      if (!uids || uids.length === 0) return [];

      const selected = newestUids(uids, limit);
      return this.#fetchSummaries(client, opened, selected);
    });
  }

  async readMessages(accountId: string, references: MessageRef[]): Promise<MessageDetail[]> {
    this.#assertAccount(accountId);
    for (const reference of references) this.#assertReference(reference);

    return this.#withClient(async (client) => {
      const details: MessageDetail[] = [];
      for (const [mailbox, mailboxReferences] of groupByMailbox(references)) {
        const opened = await client.mailboxOpen(mailbox, { readOnly: true });
        for (const reference of mailboxReferences) {
          assertUidValidity(opened, reference);
          const message = await client.fetchOne(
            reference.uid,
            { uid: true, flags: true, envelope: true, internalDate: true, source: true },
            { uid: true },
          );
          assertCurrentMessage(message, reference);
          if (!message.source) throw new Error(`Message ${reference.uid} has no downloadable source`);

          const parsed = await parseMessage(message.source);
          details.push(toDetail(this.#config.accountId, mailbox, opened, message, parsed));
        }
      }
      return details;
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
      const uids = await client.search(criteria, { uid: true });
      if (!uids || uids.length === 0) return [];

      return this.#fetchSummaries(client, opened, newestUids(uids, limit));
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

  async undo(applied: AppliedMailAction): Promise<void> {
    this.#assertReference(applied.current);
    this.#assertReference(applied.previous);
    if (applied.current.accountId !== applied.previous.accountId) {
      throw new Error("Cannot undo an action across accounts");
    }

    await this.#withClient(async (client) => {
      switch (applied.action.type) {
        case "leave":
          return;
        case "mark_read":
        case "mark_unread": {
          const opened = await client.mailboxOpen(applied.current.mailbox);
          assertUidValidity(opened, applied.current);
          const current = await client.fetchOne(applied.current.uid, { uid: true }, { uid: true });
          assertCurrentMessage(current, applied.current);
          await changeSeenFlag(client, applied.current, applied.previousRead);
          return;
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
          const moved = await client.messageMove(applied.current.uid, applied.previous.mailbox, { uid: true });
          if (!moved) throw new Error(`IMAP server refused to undo the move of UID ${applied.current.uid}`);
          return;
        }
      }
    });
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
        source: { maxLength: SUMMARY_SOURCE_BYTES },
      },
      { uid: true },
    )) {
      const parsed = message.source ? await parseMessage(message.source) : undefined;
      summaries.push(toSummary(this.#config.accountId, mailbox.path, mailbox, message, parsed));
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

  #assertReference(reference: MessageRef): void {
    this.#assertAccount(reference.accountId);
  }
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
  const options = reference.modseq === null
    ? { uid: true as const }
    : { uid: true as const, unchangedSince: BigInt(reference.modseq) };
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

function newestUids(uids: number[], limit: number): number[] {
  return [...uids].sort((left, right) => right - left).slice(0, limit);
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
    keepCidLinks: true,
    skipImageLinks: true,
    skipTextToHtml: true,
  });
}

function toSummary(
  accountId: string,
  mailboxPath: string,
  mailbox: MailboxObject,
  message: FetchMessageObject,
  parsed?: ParsedMail,
): MessageSummary {
  const receivedAt = toDate(message.internalDate) ?? message.envelope?.date ?? parsed?.date ?? new Date(0);
  const deliveredTo = deliveryAddresses(parsed);
  return {
    ref: referenceFor(accountId, mailboxPath, mailbox, message),
    messageId: message.envelope?.messageId ?? headerString(parsed, "message-id") ?? "",
    subject: message.envelope?.subject ?? parsed?.subject ?? "(no subject)",
    from: message.envelope?.from?.map(toEnvelopeAddress) ?? parsedAddresses(parsed?.from?.value),
    to: message.envelope?.to?.map(toEnvelopeAddress) ?? parsedAddresses(flattenAddresses(parsed?.to)),
    cc: message.envelope?.cc?.map(toEnvelopeAddress) ?? parsedAddresses(flattenAddresses(parsed?.cc)),
    ...(deliveredTo.length === 0 ? {} : { deliveredTo }),
    receivedAt: receivedAt.toISOString(),
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
): MessageDetail {
  return {
    ...toSummary(accountId, mailboxPath, mailbox, message, parsed),
    text: parsed.text ?? "",
    html: parsed.html === false ? null : parsed.html,
  };
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

function headerString(parsed: ParsedMail | undefined, name: string): string | undefined {
  const value = parsed?.headers.get(name);
  return typeof value === "string" ? value : undefined;
}

function previewFor(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
