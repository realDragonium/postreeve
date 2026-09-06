import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";
import { z, type ZodType } from "zod";
import {
  sendMessageInputSchema,
  sendReceiptSchema,
  type Account,
  type Draft,
  type Folder,
  type MessageRef,
  type SendMessageInput,
  type SendReceipt,
  type TriageAction,
  type ProviderDraftRef,
} from "../../shared/contracts";
import type { GmailAccountCredentials } from "../security/credentials";
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
import { MailSendPreDispatchError, type ConversationSendContext, type MailSender } from "./sender";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_MIN_FULL_RESPONSE_BYTES = 64 * 1024 * 1024;
const GMAIL_JSON_OVERHEAD_BYTES = 2 * 1024 * 1024;
export const GMAIL_ARCHIVE = "__archive__";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().default(3600),
});
const labelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["system", "user"]).optional(),
  messagesTotal: z.number().int().nonnegative().optional(),
  messagesUnread: z.number().int().nonnegative().optional(),
});
const labelsSchema = z.object({ labels: z.array(labelSchema).default([]) });
const messageStubSchema = z.object({ id: z.string().min(1) });
const messageListSchema = z.object({
  messages: z.array(messageStubSchema).default([]),
  nextPageToken: z.string().min(1).optional(),
});
interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Array<{ name: string; value: string }>;
  body: { attachmentId?: string | undefined; size: number; data?: string | undefined };
  parts: GmailPart[];
}
const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() => z.object({
  partId: z.string().default(""),
  mimeType: z.string().default("application/octet-stream"),
  filename: z.string().default(""),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  body: z.object({
    attachmentId: z.string().min(1).optional(),
    size: z.number().int().nonnegative().default(0),
    data: z.string().optional(),
  }).default({ size: 0 }),
  parts: z.array(gmailPartSchema).default([]),
}));
const gmailPartBodySchema = z.object({ data: z.string(), size: z.number().int().nonnegative().default(0) });
const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1).optional(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  historyId: z.string().min(1).optional(),
  internalDate: z.string().optional(),
  payload: gmailPartSchema.optional(),
  raw: z.string().optional(),
});
const sentMessageSchema = z.object({ id: z.string().min(1), threadId: z.string().min(1).optional() });
const draftStubSchema = z.object({ id: z.string().min(1) });
const draftListSchema = z.object({
  drafts: z.array(draftStubSchema).default([]),
  nextPageToken: z.string().min(1).optional(),
});
const gmailDraftSchema = z.object({
  id: z.string().min(1),
  message: gmailMessageSchema,
});

export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GmailClientConfig {
  account: Account & { kind: "gmail" };
  credentials: GmailAccountCredentials;
  clientId: string;
  clientSecret?: string;
  fetch?: HttpFetch;
}

export class GmailMailClient implements MailProvider, MailSender {
  readonly #account: Account & { kind: "gmail" };
  readonly #credentials: GmailAccountCredentials;
  readonly #clientId: string;
  readonly #clientSecret: string | undefined;
  readonly #fetch: HttpFetch;
  #accessToken: { value: string; expiresAt: number } | null = null;

  constructor(config: GmailClientConfig) {
    this.#account = config.account;
    this.#credentials = config.credentials;
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#fetch = config.fetch ?? fetch;
  }

  async verifyConnection(): Promise<void> {
    await this.#request("/profile", z.object({ emailAddress: z.string().email() }));
  }

  async listFolders(accountId: string): Promise<Folder[]> {
    this.#assertAccount(accountId);
    const listed = await this.#request("/labels", labelsSchema);
    const visible = listed.labels.filter(isVisibleLabel);
    const labels = await Promise.all(visible.map(({ id }) => this.#request(`/labels/${encodeURIComponent(id)}`, labelSchema)));
    const folders = labels.map((label) => ({
      path: label.id,
      name: labelName(label),
      specialUse: specialUseFor(label.id),
      unread: label.messagesUnread ?? 0,
      total: label.messagesTotal ?? 0,
    } satisfies Folder));
    const inbox = folders.find((folder) => folder.path === "INBOX");
    const archive: Folder = {
      path: GMAIL_ARCHIVE,
      name: "Archive",
      specialUse: "archive",
      unread: 0,
      total: Math.max(0, (folders.find((folder) => folder.path === "ALL")?.total ?? 0) - (inbox?.total ?? 0)),
    };
    return [
      ...folders,
      archive,
    ].sort(folderOrder);
  }

  async createFolder(accountId: string, name: string): Promise<void> {
    this.#assertAccount(accountId);
    await this.#request("/labels", labelSchema, {
      method: "POST",
      body: JSON.stringify({
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    });
  }

  async renameFolder(accountId: string, path: string, name: string): Promise<void> {
    this.#assertAccount(accountId);
    await this.#userLabel(path);
    await this.#request(`/labels/${encodeURIComponent(path)}`, labelSchema, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async deleteFolder(accountId: string, path: string): Promise<void> {
    this.#assertAccount(accountId);
    await this.#userLabel(path);
    await this.#request(`/labels/${encodeURIComponent(path)}`, z.null(), { method: "DELETE" });
  }

  async createDraft(scope: ProviderDraftScope, draft: Draft): Promise<ProviderDraftRef> {
    this.#assertDraftScope(scope, draft);
    const matches = (await this.listDrafts(scope)).filter(({ postreeveId }) => postreeveId === draft.id);
    if (matches.length > 0) return this.#putDraft(scope, draft, matches[0]!.ref, matches);
    return this.#postDraft(scope, draft, [], new Set());
  }

  async #postDraft(
    scope: ProviderDraftScope,
    draft: Draft,
    duplicateCandidates: readonly ProviderDraft[],
    excludedRecoveryIds: ReadonlySet<string>,
  ): Promise<ProviderDraftRef> {
    try {
      const created = await this.#request("/drafts", gmailDraftSchema, {
        method: "POST",
        body: JSON.stringify({ message: await gmailDraftMessage(scope, draft) }),
      });
      const ref = { kind: "gmail", draftId: created.id } as const;
      await this.#removeDuplicateDrafts(ref, duplicateCandidates);
      return ref;
    } catch (error) {
      const recovered = (await this.listDrafts(scope))
        .filter((candidate) => candidate.postreeveId === draft.id
          && candidate.version === draft.version
          && candidate.ref.kind === "gmail"
          && !excludedRecoveryIds.has(candidate.ref.draftId));
      if (recovered.length === 0) throw error;
      await this.#removeDuplicateDrafts(recovered[0]!.ref, [...duplicateCandidates, ...recovered]);
      return recovered[0]!.ref;
    }
  }

  async updateDraft(scope: ProviderDraftScope, draft: Draft, ref: ProviderDraftRef): Promise<ProviderDraftRef> {
    this.#assertDraftScope(scope, draft);
    if (ref.kind !== "gmail") throw new Error("Gmail cannot update a draft reference from another provider");
    const discovered = (await this.listDrafts(scope)).filter(({ postreeveId }) => postreeveId === draft.id);
    const exact = discovered.some((candidate) => candidate.ref.kind === "gmail" && candidate.ref.draftId === ref.draftId)
      ? null
      : await this.#resolveExactProviderDraft(scope, draft.id, ref.draftId);
    const matches = exact ? [...discovered, exact] : discovered;
    return matches.length === 0
      ? this.#postDraft(scope, draft, [], new Set())
      : this.#putDraft(scope, draft, ref, matches);
  }

  async listDrafts(scope: ProviderDraftScope): Promise<ProviderDraft[]> {
    this.#assertDraftScope(scope);
    const listed: ProviderDraft[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ maxResults: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.#request(`/drafts?${query.toString()}`, draftListSchema);
      for (const { id } of response.drafts) {
        const container = await this.#request(`/drafts/${encodeURIComponent(id)}?format=raw`, gmailDraftSchema);
        const raw = container.message.raw;
        if (raw === undefined) throw new Error(`Gmail did not return raw content for draft ${container.id}`);
        const markers = parseProviderDraftMarkers(fromBase64Url(raw));
        if (markers?.tenantId === scope.tenantId && markers.accountId === scope.accountId) {
          listed.push({ ...markers, ref: { kind: "gmail", draftId: container.id } });
        }
      }
      pageToken = response.nextPageToken;
      if (!pageToken) return listed;
    }
    throw new Error("Gmail draft pagination exceeded the reconciliation bound");
  }

  async removeDraft(scope: ProviderDraftScope, postreeveId: string, ref?: ProviderDraftRef): Promise<void> {
    this.#assertDraftScope(scope);
    if (ref?.kind === "imap") throw new Error("Gmail cannot remove a draft reference from another provider");
    const matches = (await this.listDrafts(scope)).filter((draft) => draft.postreeveId === postreeveId);
    const ids = new Set(matches.map(({ ref: candidate }) => candidate.kind === "gmail" ? candidate.draftId : ""));
    if (ref?.kind === "gmail" && !ids.has(ref.draftId)) {
      const exact = await this.#resolveExactProviderDraft(scope, postreeveId, ref.draftId);
      if (exact) ids.add(ref.draftId);
    }
    for (const id of ids) {
      if (!id) continue;
      await this.#deleteDraftContainer(id);
    }
  }

  async listMessages(accountId: string, mailbox: string, limit: number): Promise<ProviderMessageSummary[]> {
    return (await this.listMessagePage(accountId, mailbox, limit)).messages;
  }

  async listMessagePage(accountId: string, mailbox: string, limit: number): Promise<MailboxPage> {
    this.#assertAccount(accountId);
    return this.#listPage(mailbox, "", limit);
  }

  async searchMessages(accountId: string, mailbox: string, query: string, limit: number): Promise<ProviderMessageSummary[]> {
    this.#assertAccount(accountId);
    return (await this.#listPage(mailbox, query.trim(), limit)).messages;
  }

  async readMessages(accountId: string, references: MessageRef[]): Promise<ProviderMessageDetail[]> {
    this.#assertAccount(accountId);
    return Promise.all(references.map(async (reference) => {
      this.#assertReference(reference);
      const id = providerId(reference);
      const message = await this.#request(`/messages/${encodeURIComponent(id)}?format=full`, gmailMessageSchema);
      if (message.id !== id) throw new Error(`Gmail returned the wrong message while reading ${id}`);
      if (!message.payload) throw new Error("Gmail did not return the message body structure");
      const rendered = await renderGmailBody(id, message.payload, (part) => this.#gmailPartContent(id, part));
      const parsedHeaders = await parseGmailHeaders(message.payload.headers);
      return toDetail(this.#account.id, reference.mailbox, message, rendered, parsedHeaders);
    }));
  }

  async downloadAttachment(
    accountId: string,
    locator: ProviderAttachmentLocator,
    maxBytes: number,
  ): Promise<ProviderAttachmentDownload> {
    this.#assertAccount(accountId);
    if (locator.kind !== "gmail") throw new Error("Gmail cannot download another provider's attachment");
    const attachmentResponseLimit = Math.ceil(maxBytes * 4 / 3) + GMAIL_JSON_OVERHEAD_BYTES;
    const messageResponseLimit = Math.max(GMAIL_MIN_FULL_RESPONSE_BYTES, attachmentResponseLimit);
    const message = await this.#request(
      `/messages/${encodeURIComponent(locator.messageId)}?format=full`,
      gmailMessageSchema,
      {},
      messageResponseLimit,
    );
    if (message.id !== locator.messageId) throw new Error("Gmail attachment reference is stale");
    if (!message.payload) throw new Error("Gmail did not return the message body structure");
    const attachment = gmailAttachments(locator.messageId, message.payload)
      .find(({ locator: candidate }) => candidate.kind === "gmail" && candidate.partId === locator.partId);
    if (!attachment) throw new Error("Gmail attachment reference is stale");
    const part = visibleGmailParts(message.payload).find(({ part: candidate }) => candidate.partId === locator.partId)?.part;
    if (!part) throw new Error("Gmail attachment reference is stale");
    if (part.body.size > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte download limit`);
    const content = await this.#gmailPartContent(locator.messageId, part, attachmentResponseLimit);
    if (content.byteLength > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte download limit`);
    return { filename: attachment.filename, mediaType: attachment.mediaType, content };
  }

  async #gmailPartContent(messageId: string, part: GmailPart, responseLimit?: number): Promise<Buffer> {
    if (part.body.data !== undefined) return decodeGmailPartBody(part.body.data, part.body.size);
    if (!part.body.attachmentId) {
      if (part.body.size > 0) throw new Error("Gmail returned incomplete attachment data");
      return Buffer.alloc(0);
    }
    const body = await this.#request(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
      gmailPartBodySchema,
      {},
      responseLimit,
    );
    if (body.size !== part.body.size) throw new Error("Gmail returned inconsistent attachment size");
    return decodeGmailPartBody(body.data, body.size);
  }

  async revalidate(reference: MessageRef): Promise<boolean> {
    this.#assertReference(reference);
    try {
      const message = await this.#getMinimal(providerId(reference));
      return reference.modseq === null || message.historyId === reference.modseq;
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return false;
      throw error;
    }
  }

  async apply(reference: MessageRef, action: TriageAction): Promise<AppliedMailAction> {
    this.#assertReference(reference);
    const id = providerId(reference);
    const before = await this.#getMinimal(id);
    if (reference.modseq !== null && before.historyId !== reference.modseq) {
      throw new Error("The Gmail message changed since it was listed");
    }
    const previous = toReference(this.#account.id, reference.mailbox, before);
    const previousRead = !before.labelIds.includes("UNREAD");
    let after = before;
    let mailbox = reference.mailbox;

    switch (action.type) {
      case "leave":
        break;
      case "mark_read":
        after = await this.#modify(id, [], ["UNREAD"]);
        break;
      case "mark_unread":
        after = await this.#modify(id, ["UNREAD"], []);
        break;
      case "trash":
        after = await this.#request(`/messages/${encodeURIComponent(id)}/trash`, gmailMessageSchema, { method: "POST" });
        mailbox = "TRASH";
        break;
      case "move": {
        const add = action.destination === GMAIL_ARCHIVE ? [] : [action.destination];
        const remove = reference.mailbox === GMAIL_ARCHIVE
          ? []
          : [reference.mailbox];
        if (action.destination === GMAIL_ARCHIVE && !remove.includes("INBOX")) remove.push("INBOX");
        after = await this.#modify(id, add, remove.filter((label) => !add.includes(label)));
        mailbox = action.destination;
        break;
      }
    }

    return {
      current: toReference(this.#account.id, mailbox, after),
      previous,
      action,
      previousRead,
    };
  }

  async undo(applied: AppliedMailAction): Promise<ProviderLocationMove | null> {
    this.#assertReference(applied.current);
    const id = providerId(applied.current);
    switch (applied.action.type) {
      case "leave":
        return null;
      case "mark_read":
      case "mark_unread":
        await this.#modify(id, applied.previousRead ? [] : ["UNREAD"], applied.previousRead ? ["UNREAD"] : []);
        return null;
      case "trash":
        await this.#request(`/messages/${encodeURIComponent(id)}/untrash`, gmailMessageSchema, { method: "POST" });
        return null;
      case "move": {
        const add = applied.previous.mailbox === GMAIL_ARCHIVE ? [] : [applied.previous.mailbox];
        const remove = applied.current.mailbox === GMAIL_ARCHIVE ? [] : [applied.current.mailbox];
        if (applied.current.mailbox === GMAIL_ARCHIVE && applied.previous.mailbox === "INBOX") add.push("INBOX");
        await this.#modify(id, add, remove.filter((label) => !add.includes(label)));
        return null;
      }
    }
  }

  async send(rawInput: SendMessageInput, context?: ConversationSendContext): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    this.#assertAccount(input.accountId);
    const reply = context?.type === "reply" || context?.type === "reply_all" ? context : undefined;
    const submittedAt = new Date().toISOString();
    const messageId = `<${crypto.randomUUID()}@postreeve.local>`;
    let raw: string;
    try {
      raw = await buildMessage(this.#account, input, messageId, submittedAt, reply);
    } catch (error) {
      throw preDispatchError(error);
    }
    let token: string;
    try {
      token = await this.#token();
    } catch (error) {
      throw preDispatchError(error);
    }
    const sent = await this.#requestWithToken(token, "/messages/send", sentMessageSchema, {
      method: "POST",
      body: JSON.stringify({
        raw: toBase64Url(Buffer.from(raw, "utf8")),
        ...(reply?.inReplyTo
          && reply.providerConversationId
          && reply.sourceSubject !== undefined
          && input.subject === replySubject(reply.sourceSubject)
          ? { threadId: reply.providerConversationId }
          : {}),
      }),
    });
    return sendReceiptSchema.parse({
      id: sent.id,
      accountId: this.#account.id,
      messageId,
      ...(sent.threadId ? { providerConversationId: sent.threadId } : {}),
      accepted: [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address),
      rejected: [],
      submittedAt,
    });
  }

  async #putDraft(
    scope: ProviderDraftScope,
    draft: Draft,
    requestedRef: ProviderDraftRef,
    matches: readonly ProviderDraft[],
  ): Promise<ProviderDraftRef> {
    if (requestedRef.kind !== "gmail") throw new Error("Gmail cannot update a draft reference from another provider");
    const selected = matches.find(({ ref }) => ref.kind === "gmail" && ref.draftId === requestedRef.draftId) ?? matches[0];
    if (!selected || selected.ref.kind !== "gmail") return this.#postDraft(scope, draft, matches, new Set());
    const selectedDraftId = selected.ref.draftId;
    let resultRef: ProviderDraftRef;
    let duplicateCandidates = matches;
    try {
      const updated = await this.#request(`/drafts/${encodeURIComponent(selected.ref.draftId)}`, gmailDraftSchema, {
        method: "PUT",
        body: JSON.stringify({ message: await gmailDraftMessage(scope, draft) }),
      });
      resultRef = { kind: "gmail", draftId: updated.id };
    } catch (error) {
      const recovered = (await this.listDrafts(scope))
        .filter((candidate) => candidate.postreeveId === draft.id
          && candidate.version === draft.version
          && !(error instanceof GmailHttpError
            && error.status === 404
            && candidate.ref.kind === "gmail"
            && candidate.ref.draftId === selectedDraftId));
      if (recovered.length === 0) {
        if (error instanceof GmailHttpError && error.status === 404) {
          const staleIds = new Set(matches.flatMap(({ ref }) => ref.kind === "gmail" ? [ref.draftId] : []));
          return this.#postDraft(scope, draft, matches, staleIds);
        }
        throw error;
      }
      resultRef = recovered[0]!.ref;
      duplicateCandidates = [...matches, ...recovered];
    }
    await this.#removeDuplicateDrafts(resultRef, duplicateCandidates);
    return resultRef;
  }

  async #removeDuplicateDrafts(
    keep: ProviderDraftRef,
    candidates: readonly ProviderDraft[],
  ): Promise<void> {
    if (keep.kind !== "gmail") throw new Error("Gmail cannot retain a draft reference from another provider");
    const duplicateIds = new Set(candidates.flatMap(({ ref }) => ref.kind === "gmail" && ref.draftId !== keep.draftId
      ? [ref.draftId]
      : []));
    for (const id of duplicateIds) {
      await this.#deleteDraftContainer(id);
    }
  }

  async #deleteDraftContainer(id: string): Promise<void> {
    try {
      await this.#request(`/drafts/${encodeURIComponent(id)}`, z.null(), { method: "DELETE" });
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return;
      try {
        await this.#request(`/drafts/${encodeURIComponent(id)}?format=minimal`, gmailDraftSchema);
      } catch (recheckError) {
        if (recheckError instanceof GmailHttpError && recheckError.status === 404) return;
      }
      throw error;
    }
  }

  async #resolveExactProviderDraft(
    scope: ProviderDraftScope,
    postreeveId: string,
    id: string,
  ): Promise<ProviderDraft | null> {
    let container: z.infer<typeof gmailDraftSchema>;
    try {
      container = await this.#request(`/drafts/${encodeURIComponent(id)}?format=raw`, gmailDraftSchema);
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return null;
      throw error;
    }
    if (container.id !== id) throw new Error(`Gmail returned the wrong draft while resolving ${id}`);
    const raw = container.message.raw;
    if (raw === undefined) throw new Error(`Gmail did not return raw content for draft ${container.id}`);
    const markers = parseProviderDraftMarkers(fromBase64Url(raw));
    return markers?.tenantId === scope.tenantId
      && markers.accountId === scope.accountId
      && markers.postreeveId === postreeveId
      ? { ...markers, ref: { kind: "gmail", draftId: container.id } }
      : null;
  }

  async #listPage(mailbox: string, query: string, limit: number): Promise<MailboxPage> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Message limit must be a positive integer");
    const params = new URLSearchParams({ maxResults: String(limit) });
    const archiveQuery = "-label:inbox -label:sent -label:drafts -label:spam -label:trash";
    if (mailbox === GMAIL_ARCHIVE) {
      params.set("q", query ? `${archiveQuery} ${query}` : archiveQuery);
    } else {
      params.set("labelIds", mailbox);
      if (query) params.set("q", query);
    }
    const listed = await this.#request(`/messages?${params.toString()}`, messageListSchema);
    const messages = await Promise.all(listed.messages.map(({ id }) => {
      const metadata = new URLSearchParams({ format: "metadata" });
      for (const header of ["Subject", "From", "Reply-To", "To", "Cc", "Delivered-To", "Message-ID", "In-Reply-To", "References", "Date"]) {
        metadata.append("metadataHeaders", header);
      }
      return this.#request(`/messages/${encodeURIComponent(id)}?${metadata.toString()}`, gmailMessageSchema);
    }));
    return {
      messages: messages.map((message) => toSummary(this.#account.id, mailbox, message)),
      complete: listed.nextPageToken === undefined,
    };
  }

  async #getMinimal(id: string) {
    return this.#request(`/messages/${encodeURIComponent(id)}?format=minimal`, gmailMessageSchema);
  }

  async #userLabel(path: string) {
    if (path === GMAIL_ARCHIVE) throw new Error("System and synthetic folders cannot be changed");
    const label = await this.#request(`/labels/${encodeURIComponent(path)}`, labelSchema);
    if (label.type !== "user") throw new Error("System Gmail labels cannot be changed");
    return label;
  }

  async #modify(id: string, addLabelIds: string[], removeLabelIds: string[]) {
    return this.#request(`/messages/${encodeURIComponent(id)}/modify`, gmailMessageSchema, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  async #request<T>(
    path: string,
    schema: ZodType<T>,
    init: RequestInit = {},
    maxResponseBytes?: number,
  ): Promise<T> {
    const token = await this.#token();
    return this.#requestWithToken(token, path, schema, init, maxResponseBytes);
  }

  async #requestWithToken<T>(
    token: string,
    path: string,
    schema: ZodType<T>,
    init: RequestInit = {},
    maxResponseBytes?: number,
  ): Promise<T> {
    const response = await this.#fetch(`${GMAIL_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await responseJson(response, maxResponseBytes);
    if (!response.ok) throw new GmailHttpError(response.status, googleError(body));
    return schema.parse(body);
  }

  async #token(): Promise<string> {
    if (this.#accessToken && this.#accessToken.expiresAt > Date.now() + 60_000) return this.#accessToken.value;
    const tokenRequest = new URLSearchParams({
      client_id: this.#clientId,
      refresh_token: this.#credentials.refreshToken,
      grant_type: "refresh_token",
    });
    if (this.#clientSecret) tokenRequest.set("client_secret", this.#clientSecret);
    const response = await this.#fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenRequest,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new GmailHttpError(response.status, googleError(body));
    const token = tokenSchema.parse(body);
    this.#accessToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }

  #assertAccount(accountId: string): void {
    if (accountId !== this.#account.id) throw new Error("This Gmail client cannot access another account");
  }

  #assertDraftScope(scope: ProviderDraftScope, draft?: Draft): void {
    this.#assertAccount(scope.accountId);
    if (!scope.tenantId.trim()) throw new Error("A tenant ID is required for provider drafts");
    if (draft) this.#assertAccount(draft.accountId);
  }

  #assertReference(reference: MessageRef): void {
    this.#assertAccount(reference.accountId);
    providerId(reference);
  }
}

class GmailHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function providerId(reference: MessageRef): string {
  if (!reference.providerId) throw new Error("Gmail message reference has no provider ID");
  return reference.providerId;
}

function googleError(body: unknown): string {
  const parsed = z.object({
    error: z.union([
      z.string(),
      z.object({ message: z.string().optional() }),
    ]).optional(),
    error_description: z.string().optional(),
  }).safeParse(body);
  if (!parsed.success) return "Google rejected the request";
  if (typeof parsed.data.error === "string") {
    return parsed.data.error_description?.trim() || parsed.data.error.trim() || "Google rejected the request";
  }
  return parsed.data.error?.message?.trim() || "Google rejected the request";
}

function isVisibleLabel(label: z.infer<typeof labelSchema>): boolean {
  if (label.type === "user") return true;
  return ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "ALL"].includes(label.id);
}

function labelName(label: z.infer<typeof labelSchema>): string {
  return ({ INBOX: "Inbox", SENT: "Sent", DRAFT: "Drafts", TRASH: "Trash", SPAM: "Spam", ALL: "All mail" } as const)[label.id as "INBOX"] ?? label.name;
}

function specialUseFor(labelId: string): Folder["specialUse"] {
  return ({ INBOX: "inbox", SENT: "sent", DRAFT: "drafts", TRASH: "trash", SPAM: "junk", ALL: null } as const)[labelId as "INBOX"] ?? null;
}

function folderOrder(left: Folder, right: Folder): number {
  const order = ["inbox", "archive", "drafts", "sent", "trash", "junk", null];
  return order.indexOf(left.specialUse) - order.indexOf(right.specialUse) || left.name.localeCompare(right.name);
}

function toSummary(accountId: string, mailbox: string, message: z.infer<typeof gmailMessageSchema>): ProviderMessageSummary {
  const headerList = message.payload?.headers ?? [];
  const headers = new Map(headerList.map(({ name, value }) => [name.trim().toLocaleLowerCase(), value]));
  const rawReferences = headerValues(headerList, "references");
  const identification = normalizeIdentificationFields({
    messageId: headerValues(headerList, "message-id"),
    inReplyTo: headerValues(headerList, "in-reply-to"),
    references: rawReferences,
  });
  const canonicalReceivedAt = receivedAt(message, headers.get("date"));
  return {
    ...(message.threadId ? { providerConversationId: message.threadId } : {}),
    ref: toReference(accountId, mailbox, message),
    messageId: identification.messageId ?? "",
    inReplyTo: identification.inReplyTo,
    references: identification.references,
    referenceSequences: normalizeReferenceSequences(rawReferences),
    subject: headers.get("subject") ?? "(no subject)",
    from: parseAddresses(headers.get("from")),
    replyTo: parseAddresses(headers.get("reply-to")),
    to: parseAddresses(headers.get("to")),
    cc: parseAddresses(headers.get("cc")),
    deliveredTo: parseAddresses(headers.get("delivered-to")).map(({ address }) => address).filter(isEmail),
    canonicalReceivedAt,
    receivedAt: canonicalReceivedAt ?? new Date(0).toISOString(),
    preview: message.snippet,
    read: !message.labelIds.includes("UNREAD"),
    flagged: message.labelIds.includes("STARRED"),
  };
}

function toDetail(
  accountId: string,
  mailbox: string,
  message: z.infer<typeof gmailMessageSchema>,
  rendered: { text: string; html: string | null; attachments: ProviderAttachment[] },
  parsedHeaders: ParsedMail,
): ProviderMessageDetail {
  const summary = toSummary(accountId, mailbox, message);
  return {
    ...summary,
    ...rendered,
    subject: parsedHeaders.subject ?? summary.subject,
    from: flattenAddresses(parsedHeaders.from).map(toAddress),
    replyTo: flattenAddresses(parsedHeaders.replyTo).map(toAddress),
    to: flattenAddresses(parsedHeaders.to).map(toAddress),
    cc: flattenAddresses(parsedHeaders.cc).map(toAddress),
  };
}

async function parseGmailHeaders(headers: readonly { name: string; value: string }[]): Promise<ParsedMail> {
  const block = headers.map(({ name, value }) => `${name}: ${value}`).join("\r\n");
  return simpleParser(Buffer.from(`${block}\r\n\r\n`), {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
}

function flattenAddresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!value) return [];
  const addresses = Array.isArray(value) ? value.flatMap((entry) => entry.value) : value.value;
  return addresses.flatMap(flattenEmailAddress);
}

function flattenEmailAddress(value: EmailAddress): EmailAddress[] {
  return value.group ? value.group.flatMap(flattenEmailAddress) : [value];
}

function toAddress(value: EmailAddress): { name: string; address: string } {
  return { name: value.name ?? "", address: value.address ?? "" };
}

async function renderGmailBody(
  messageId: string,
  root: GmailPart,
  load: (part: GmailPart) => Promise<Buffer>,
): Promise<{ text: string; html: string | null; attachments: ProviderAttachment[] }> {
  const body = await readGmailText(root, load);
  const cids = referencedCids(body.html);
  let html = body.html;
  if (html) {
    for (const { part } of visibleGmailParts(root)) {
      const cid = contentId(part);
      if (!cid || !cids.has(cid) || !safeAttachmentMediaType(part.mimeType).startsWith("image/")) continue;
      const content = await load(part);
      const dataUrl = `data:${safeAttachmentMediaType(part.mimeType)};base64,${content.toString("base64")}`;
      html = replaceCid(html, cid, dataUrl);
    }
  }
  return {
    ...body,
    html,
    attachments: gmailAttachments(messageId, root),
  };
}

async function readGmailText(
  root: GmailPart,
  load: (part: GmailPart) => Promise<Buffer>,
): Promise<{ text: string; html: string | null }> {
  const plain: string[] = [];
  const html: string[] = [];
  for (const { part } of visibleGmailParts(root)) {
    const mediaType = safeAttachmentMediaType(part.mimeType);
    if ((mediaType !== "text/plain" && mediaType !== "text/html") || isFilePart(part)) continue;
    const decoded = await decodeGmailText(await load(part), part, mediaType);
    if (mediaType === "text/plain") plain.push(decoded);
    else html.push(decoded);
  }
  return { text: plain.join("\n"), html: html.length > 0 ? html.join("<br/>\n") : null };
}

function gmailAttachments(messageId: string, root: GmailPart): ProviderAttachment[] {
  return visibleGmailParts(root).flatMap(({ part, root: isRoot }) => {
    if (!isFilePart(part)) return [];
    if (!part.partId && !isRoot) throw new Error("Gmail returned an attachment without a part identity");
    return [{
      locator: { kind: "gmail", messageId, partId: part.partId },
      filename: safeAttachmentFilename(part.filename || dispositionFilename(part) || "attachment"),
      mediaType: safeAttachmentMediaType(part.mimeType),
      size: part.body.size,
      sizeIsEstimate: false,
    }];
  });
}

function visibleGmailParts(root: GmailPart): Array<{ part: GmailPart; root: boolean }> {
  const result: Array<{ part: GmailPart; root: boolean }> = [];
  const pending = [{ part: root, root: true }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    result.push(current);
    if (!isFilePart(current.part)) {
      pending.push(...current.part.parts.toReversed().map((part) => ({ part, root: false })));
    }
  }
  return result;
}

function isFilePart(part: GmailPart): boolean {
  return Boolean(part.filename.trim() || disposition(part).startsWith("attachment"));
}

function disposition(part: GmailPart): string {
  return headerValues(part.headers, "content-disposition")[0]?.trim().toLowerCase() ?? "";
}

function dispositionFilename(part: GmailPart): string | undefined {
  const value = headerValues(part.headers, "content-disposition")[0] ?? "";
  return /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(value)?.[1]?.trim();
}

function contentId(part: GmailPart): string | null {
  const value = headerValues(part.headers, "content-id")[0]?.trim().replace(/^<|>$/g, "").trim();
  return value ? value.toLowerCase() : null;
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

async function decodeGmailText(content: Buffer, part: GmailPart, mediaType: string): Promise<string> {
  const contentType = headerValues(part.headers, "content-type")[0] ?? `${mediaType}; charset=utf-8`;
  const parsed = await simpleParser(Buffer.concat([
    Buffer.from(`Content-Type: ${contentType}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`),
    content,
  ]), {
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  return (mediaType === "text/html" && typeof parsed.html === "string" ? parsed.html : parsed.text ?? "")
    .replace(/\r?\n/g, "\n");
}

function toReference(accountId: string, mailbox: string, message: z.infer<typeof gmailMessageSchema>): MessageRef {
  return {
    accountId,
    mailbox,
    uidValidity: "gmail",
    uid: numericId(message.id),
    modseq: message.historyId ?? null,
    providerId: message.id,
  };
}

function numericId(value: string): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(value, "utf8")) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0) || 1;
}

function receivedAt(message: z.infer<typeof gmailMessageSchema>, dateHeader?: string): string | null {
  const internal = message.internalDate === undefined || !/^\d+$/.test(message.internalDate)
    ? null
    : validDate(Number(message.internalDate));
  const header = dateHeader === undefined ? null : validDate(dateHeader);
  return (internal ?? header)?.toISOString() ?? null;
}

function validDate(value: string | number): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function parseAddresses(value?: string): Array<{ name: string; address: string }> {
  if (!value) return [];
  return value.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).flatMap((part) => {
    const trimmed = part.trim();
    const match = /^(?:\"?([^\"<]*)\"?\s*)?<([^>]+)>$/.exec(trimmed);
    const address = (match?.[2] ?? trimmed).trim();
    return address ? [{ name: (match?.[1] ?? "").trim(), address }] : [];
  });
}

function headerValues(headers: readonly { name: string; value: string }[], name: string): string[] {
  return headers
    .filter((header) => header.name.trim().toLowerCase() === name)
    .map(({ value }) => value);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function responseJson(response: Response, maxBytes?: number): Promise<unknown> {
  if (maxBytes === undefined) return response.json().catch(() => null);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Gmail attachment response exceeds the configured download limit");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Gmail attachment response exceeds the configured download limit");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8"));
  } catch {
    return null;
  }
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function preDispatchError(error: unknown): MailSendPreDispatchError {
  return error instanceof MailSendPreDispatchError && error.message.trim()
    ? error
    : new MailSendPreDispatchError(error instanceof Error ? error.message : "Mail preparation failed", { cause: error });
}

async function gmailDraftMessage(scope: ProviderDraftScope, draft: Draft): Promise<{ raw: string }> {
  return { raw: toBase64Url(await buildProviderDraftMessage(scope, draft)) };
}

async function buildMessage(
  account: Account,
  input: SendMessageInput,
  messageId: string,
  submittedAt: string,
  context?: Extract<ConversationSendContext, { type: "reply" | "reply_all" }>,
): Promise<string> {
  const recipients = [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address);
  const message = new MailComposer({
    from: { name: account.name, address: account.email },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    envelope: { from: account.email, to: recipients },
    subject: input.subject.replace(/[\r\n]/g, " "),
    text: input.text,
    textEncoding: "base64",
    messageId,
    date: new Date(submittedAt),
    ...(context?.inReplyTo ? { inReplyTo: context.inReplyTo } : {}),
    ...(context && context.references.length > 0 ? { references: [...context.references] } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  message.keepBcc = true;
  return (await message.build()).toString("utf8");
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function decodeGmailPartBody(value: string, expectedBytes: number): Buffer {
  const unpadded = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value) || unpadded.length % 4 === 1) {
    throw new Error("Gmail returned malformed attachment data");
  }
  const decoded = Buffer.from(unpadded, "base64url");
  if (decoded.toString("base64url") !== unpadded) throw new Error("Gmail returned malformed attachment data");
  if (decoded.byteLength !== expectedBytes) throw new Error("Gmail returned inconsistent attachment size");
  return decoded;
}
