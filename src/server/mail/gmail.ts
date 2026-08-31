import { simpleParser, type EmailAddress, type ParsedMail } from "mailparser";
import { z, type ZodType } from "zod";
import type {
  Account,
  Folder,
  MessageDetail,
  MessageRef,
  MessageSummary,
  OutboundAddress,
  SendMessageInput,
  SendReceipt,
  TriageAction,
} from "../../shared/contracts";
import type { GmailAccountCredentials } from "../security/credentials";
import type { AppliedMailAction, MailProvider } from "./provider";
import type { MailSender } from "./sender";

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
const messageListSchema = z.object({ messages: z.array(messageStubSchema).default([]) });
const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  historyId: z.string().min(1).optional(),
  internalDate: z.string().optional(),
  payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }).optional(),
  raw: z.string().optional(),
});
const sentMessageSchema = z.object({ id: z.string().min(1), threadId: z.string().optional() });

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

  async listMessages(accountId: string, mailbox: string, limit: number): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    return this.#list(mailbox, "", limit);
  }

  async searchMessages(accountId: string, mailbox: string, query: string, limit: number): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    return this.#list(mailbox, query.trim(), limit);
  }

  async readMessages(accountId: string, references: MessageRef[]): Promise<MessageDetail[]> {
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

  async undo(applied: AppliedMailAction): Promise<void> {
    this.#assertReference(applied.current);
    const id = providerId(applied.current);
    switch (applied.action.type) {
      case "leave":
        return;
      case "mark_read":
      case "mark_unread":
        await this.#modify(id, applied.previousRead ? [] : ["UNREAD"], applied.previousRead ? ["UNREAD"] : []);
        return;
      case "trash":
        await this.#request(`/messages/${encodeURIComponent(id)}/untrash`, gmailMessageSchema, { method: "POST" });
        return;
      case "move": {
        const add = applied.previous.mailbox === GMAIL_ARCHIVE ? [] : [applied.previous.mailbox];
        const remove = applied.current.mailbox === GMAIL_ARCHIVE ? [] : [applied.current.mailbox];
        if (applied.current.mailbox === GMAIL_ARCHIVE && applied.previous.mailbox === "INBOX") add.push("INBOX");
        await this.#modify(id, add, remove.filter((label) => !add.includes(label)));
      }
    }
  }

  async send(input: SendMessageInput): Promise<SendReceipt> {
    this.#assertAccount(input.accountId);
    const submittedAt = new Date().toISOString();
    const messageId = `<${crypto.randomUUID()}@postreeve.local>`;
    const raw = buildMessage(this.#account, input, messageId, submittedAt);
    const sent = await this.#request("/messages/send", sentMessageSchema, {
      method: "POST",
      body: JSON.stringify({ raw: toBase64Url(Buffer.from(raw, "utf8")) }),
    });
    return {
      id: sent.id,
      accountId: this.#account.id,
      messageId,
      accepted: [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address),
      rejected: [],
      submittedAt,
    };
  }

  async #list(mailbox: string, query: string, limit: number): Promise<MessageSummary[]> {
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
      for (const header of ["Subject", "From", "To", "Cc", "Delivered-To", "Message-ID", "Date"]) {
        metadata.append("metadataHeaders", header);
      }
      return this.#request(`/messages/${encodeURIComponent(id)}?${metadata.toString()}`, gmailMessageSchema);
    }));
    return messages.map((message) => toSummary(this.#account.id, mailbox, message));
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
  if (typeof parsed.data.error === "string") return parsed.data.error_description ?? parsed.data.error;
  return parsed.data.error?.message ?? "Google rejected the request";
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

function toSummary(accountId: string, mailbox: string, message: z.infer<typeof gmailMessageSchema>): MessageSummary {
  const headers = new Map((message.payload?.headers ?? []).map(({ name, value }) => [name.toLocaleLowerCase(), value]));
  return {
    ref: toReference(accountId, mailbox, message),
    messageId: headers.get("message-id") ?? message.id,
    subject: headers.get("subject") ?? "(no subject)",
    from: parseAddresses(headers.get("from")),
    to: parseAddresses(headers.get("to")),
    cc: parseAddresses(headers.get("cc")),
    deliveredTo: parseAddresses(headers.get("delivered-to")).map(({ address }) => address).filter(isEmail),
    receivedAt: receivedAt(message, headers.get("date")),
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
): MessageDetail {
  const summary = toSummary(accountId, mailbox, {
    ...message,
    payload: {
      headers: [
        ["Subject", parsed.subject],
        ["From", parsed.from?.text],
        ["To", addressText(parsed.to)],
        ["Cc", addressText(parsed.cc)],
        ["Delivered-To", headerString(parsed, "delivered-to")],
        ["Message-ID", parsed.messageId],
        ["Date", parsed.date?.toUTCString()],
      ].flatMap(([name, value]) => value ? [{ name: name!, value }] : []),
    },
  });
  return {
    ...summary,
    from: flattenAddresses(parsed.from).map(toAddress),
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

function receivedAt(message: z.infer<typeof gmailMessageSchema>, dateHeader?: string): string {
  const internal = message.internalDate ? Number(message.internalDate) : Number.NaN;
  const date = Number.isFinite(internal) ? new Date(internal) : new Date(dateHeader ?? 0);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
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
  return typeof value === "string" ? value : undefined;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function buildMessage(account: Account, input: SendMessageInput, messageId: string, submittedAt: string): string {
  const headers = [
    `From: ${formatAddress({ name: account.name, address: account.email })}`,
    `To: ${input.to.map(formatAddress).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(formatAddress).join(", ")}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date(submittedAt).toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${Buffer.from(input.text, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n")}`;
}

function formatAddress(address: OutboundAddress): string {
  const name = address.name.trim();
  return name ? `${encodeHeader(name)} <${address.address}>` : address.address;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value.replace(/[\r\n]/g, " ") : `=?UTF-8?B?${Buffer.from(value.replace(/[\r\n]/g, " "), "utf8").toString("base64")}?=`;
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}
