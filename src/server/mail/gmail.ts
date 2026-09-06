import { simpleParser, type EmailAddress, type ParsedMail } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
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
} from "./provider";
import { buildProviderDraftMessage, parseProviderDraftMarkers } from "./provider-draft";
import { normalizeIdentificationFields, normalizeReferenceSequences } from "./message-id";
import { MailSendPreDispatchError, type ConversationSendContext, type MailSender } from "./sender";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
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
const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1).optional(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  historyId: z.string().min(1).optional(),
  internalDate: z.string().optional(),
  payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }).optional(),
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

  async createDraft(accountId: string, draft: Draft): Promise<ProviderDraftRef> {
    this.#assertAccount(accountId);
    this.#assertAccount(draft.accountId);
    const matches = (await this.listDrafts(accountId)).filter(({ postreeveId }) => postreeveId === draft.id);
    if (matches.length > 0) return this.#putDraft(draft, matches[0]!.ref, matches);
    try {
      const created = await this.#request("/drafts", gmailDraftSchema, {
        method: "POST",
        body: JSON.stringify({ message: gmailDraftMessage(draft) }),
      });
      return { kind: "gmail", draftId: created.id };
    } catch (error) {
      const recovered = (await this.listDrafts(accountId))
        .filter((candidate) => candidate.postreeveId === draft.id && candidate.version === draft.version);
      if (recovered.length === 0) throw error;
      await this.#removeDuplicateDrafts(recovered[0]!.ref, recovered);
      return recovered[0]!.ref;
    }
  }

  async updateDraft(accountId: string, draft: Draft, ref: ProviderDraftRef): Promise<ProviderDraftRef> {
    this.#assertAccount(accountId);
    this.#assertAccount(draft.accountId);
    if (ref.kind !== "gmail") throw new Error("Gmail cannot update a draft reference from another provider");
    const matches = (await this.listDrafts(accountId)).filter(({ postreeveId }) => postreeveId === draft.id);
    return matches.length === 0 ? this.createDraft(accountId, draft) : this.#putDraft(draft, ref, matches);
  }

  async listDrafts(accountId: string): Promise<ProviderDraft[]> {
    this.#assertAccount(accountId);
    const listed: ProviderDraft[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ maxResults: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.#request(`/drafts?${query.toString()}`, draftListSchema);
      for (const { id } of response.drafts) {
        const container = await this.#request(`/drafts/${encodeURIComponent(id)}?format=raw`, gmailDraftSchema);
        const raw = container.message.raw;
        const markers = raw ? parseProviderDraftMarkers(fromBase64Url(raw)) : null;
        if (markers) listed.push({ ...markers, ref: { kind: "gmail", draftId: container.id } });
      }
      pageToken = response.nextPageToken;
      if (!pageToken) return listed;
    }
    throw new Error("Gmail draft pagination exceeded the reconciliation bound");
  }

  async removeDraft(accountId: string, postreeveId: string, ref?: ProviderDraftRef): Promise<void> {
    this.#assertAccount(accountId);
    if (ref?.kind === "imap") throw new Error("Gmail cannot remove a draft reference from another provider");
    const matches = (await this.listDrafts(accountId)).filter((draft) => draft.postreeveId === postreeveId);
    const ids = new Set(matches.map(({ ref: candidate }) => candidate.kind === "gmail" ? candidate.draftId : ""));
    if (ref?.kind === "gmail") ids.add(ref.draftId);
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
      const message = await this.#request(`/messages/${encodeURIComponent(id)}?format=raw`, gmailMessageSchema);
      const raw = message.raw;
      if (!raw) throw new Error("Gmail did not return the message source");
      const parsed = await simpleParser(fromBase64Url(raw), {
        skipHtmlToText: true,
        skipTextToHtml: true,
      });
      return toDetail(this.#account.id, reference.mailbox, message, parsed);
    }));
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

  async #putDraft(draft: Draft, requestedRef: ProviderDraftRef, matches: readonly ProviderDraft[]): Promise<ProviderDraftRef> {
    if (requestedRef.kind !== "gmail") throw new Error("Gmail cannot update a draft reference from another provider");
    const selected = matches.find(({ ref }) => ref.kind === "gmail" && ref.draftId === requestedRef.draftId) ?? matches[0];
    if (!selected || selected.ref.kind !== "gmail") return this.createDraft(this.#account.id, draft);
    let resultRef: ProviderDraftRef;
    let duplicateCandidates = matches;
    try {
      const updated = await this.#request(`/drafts/${encodeURIComponent(selected.ref.draftId)}`, gmailDraftSchema, {
        method: "PUT",
        body: JSON.stringify({ message: gmailDraftMessage(draft) }),
      });
      resultRef = { kind: "gmail", draftId: updated.id };
    } catch (error) {
      const recovered = (await this.listDrafts(this.#account.id))
        .filter((candidate) => candidate.postreeveId === draft.id && candidate.version === draft.version);
      if (recovered.length === 0) {
        if (error instanceof GmailHttpError && error.status === 404) return this.createDraft(this.#account.id, draft);
        throw error;
      }
      resultRef = recovered[0]!.ref;
      duplicateCandidates = recovered;
    }
    await this.#removeDuplicateDrafts(resultRef, duplicateCandidates);
    return resultRef;
  }

  async #removeDuplicateDrafts(
    keep: ProviderDraftRef,
    candidates: readonly ProviderDraft[],
  ): Promise<void> {
    if (keep.kind !== "gmail") throw new Error("Gmail cannot retain a draft reference from another provider");
    for (const candidate of candidates) {
      if (candidate.ref.kind === "gmail" && candidate.ref.draftId !== keep.draftId) {
        await this.#deleteDraftContainer(candidate.ref.draftId);
      }
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

  async #request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const token = await this.#token();
    return this.#requestWithToken(token, path, schema, init);
  }

  async #requestWithToken<T>(token: string, path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${GMAIL_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => null);
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
  parsed: ParsedMail,
): ProviderMessageDetail {
  const summary = toSummary(accountId, mailbox, {
    ...message,
    payload: {
      headers: [
        ...optionalHeader("Subject", parsed.subject),
        ...optionalHeader("From", parsed.from?.text),
        ...optionalHeader("Reply-To", addressText(parsed.replyTo)),
        ...optionalHeader("To", addressText(parsed.to)),
        ...optionalHeader("Cc", addressText(parsed.cc)),
        ...optionalHeader("Delivered-To", headerString(parsed, "delivered-to")),
        ...optionalHeader("Date", rawHeaderValue(parsed, "date")),
        ...identificationHeaderEntries(parsed),
      ],
    },
  });
  return {
    ...summary,
    from: flattenAddresses(parsed.from).map(toAddress),
    replyTo: flattenAddresses(parsed.replyTo).map(toAddress),
    to: flattenAddresses(parsed.to).map(toAddress),
    cc: flattenAddresses(parsed.cc).map(toAddress),
    text: parsed.text ?? "",
    html: typeof parsed.html === "string" ? parsed.html : null,
  };
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

function flattenAddresses(value: ParsedMail["to"]): EmailAddress[] {
  if (!value) return [];
  return Array.isArray(value) ? value.flatMap((entry) => entry.value) : value.value;
}

function toAddress(value: EmailAddress): { name: string; address: string } {
  return { name: value.name ?? "", address: value.address ?? "" };
}

function addressText(value: ParsedMail["to"]): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.map(({ text }) => text).join(", ") : value.text;
}

function headerString(parsed: ParsedMail, name: string): string | undefined {
  const value = parsed.headers.get(name);
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value.join(" ")
    : undefined;
}

function rawHeaderValue(parsed: ParsedMail, name: string): string | undefined {
  return rawHeaderValues(parsed, name)[0];
}

function rawHeaderValues(parsed: ParsedMail, name: string): string[] {
  return parsed.headerLines
    .filter(({ key }) => key.toLowerCase() === name)
    .flatMap(({ line }) => {
      const separator = line.indexOf(":");
      return separator < 0 ? [] : [line.slice(separator + 1).trim()];
    });
}

function headerValues(headers: readonly { name: string; value: string }[], name: string): string[] {
  return headers
    .filter((header) => header.name.trim().toLowerCase() === name)
    .map(({ value }) => value);
}

function identificationHeaderEntries(parsed: ParsedMail): Array<{ name: string; value: string }> {
  const names: ReadonlyArray<readonly [string, string]> = [
    ["Message-ID", "message-id"],
    ["In-Reply-To", "in-reply-to"],
    ["References", "references"],
  ];
  return names.flatMap(([name, key]) => rawHeaderValues(parsed, key).map((value) => ({ name, value })));
}

function optionalHeader(name: string, value: string | undefined): Array<{ name: string; value: string }> {
  return value ? [{ name, value }] : [];
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function preDispatchError(error: unknown): MailSendPreDispatchError {
  return error instanceof MailSendPreDispatchError && error.message.trim()
    ? error
    : new MailSendPreDispatchError(error instanceof Error ? error.message : "Mail preparation failed", { cause: error });
}

function gmailDraftMessage(draft: Draft): { raw: string; threadId?: string } {
  return {
    raw: toBase64Url(buildProviderDraftMessage(draft)),
    ...(draft.source?.providerConversationId ? { threadId: draft.source.providerConversationId } : {}),
  };
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
