import type { ConversationSendSource } from "../shared/contracts";

export type ComposeMode = "new" | "reply" | "reply_all" | "forward" | "draft";
export type MessageFilter = "all" | "unread" | "flagged";
export type MessageSort = "newest" | "oldest" | "sender" | "subject";

export interface LocalAttachment {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface LocalDraft {
  readonly id: string;
  readonly accountId: string;
  readonly mode: ComposeMode;
  readonly source?: ConversationSendSource;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly LocalAttachment[];
  readonly updatedAt: string;
}

export interface LocalIdentity {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
}

const draftsKey = "postreeve.local-drafts.v1";
const identitiesKey = "postreeve.local-identities.v1";

export function loadLocalDrafts(): LocalDraft[] {
  return loadArray(draftsKey, isLocalDraft);
}

export function storeLocalDrafts(drafts: readonly LocalDraft[]): void {
  localStorage.setItem(draftsKey, JSON.stringify(drafts));
}

export function loadLocalIdentities(): LocalIdentity[] {
  return loadArray(identitiesKey, isLocalIdentity);
}

export function storeLocalIdentities(identities: readonly LocalIdentity[]): void {
  localStorage.setItem(identitiesKey, JSON.stringify(identities));
}

function loadArray<T>(key: string, guard: (value: unknown) => value is T): T[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLocalAttachment(value: unknown): value is LocalAttachment {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.size === "number"
    && typeof value.type === "string";
}

function isComposeMode(value: unknown): value is ComposeMode {
  return value === "new" || value === "reply" || value === "reply_all" || value === "forward" || value === "draft";
}

function isLocalDraft(value: unknown): value is LocalDraft {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.accountId === "string"
    && isComposeMode(value.mode)
    && (value.source === undefined || (isRecord(value.source)
      && typeof value.source.canonicalMessageId === "string"
      && typeof value.source.conversationId === "string"
      && (value.source.providerConversationId === undefined
        || typeof value.source.providerConversationId === "string")))
    && typeof value.from === "string"
    && typeof value.to === "string"
    && typeof value.cc === "string"
    && typeof value.bcc === "string"
    && typeof value.subject === "string"
    && typeof value.body === "string"
    && Array.isArray(value.attachments)
    && value.attachments.every(isLocalAttachment)
    && typeof value.updatedAt === "string";
}

function isLocalIdentity(value: unknown): value is LocalIdentity {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.accountId === "string"
    && typeof value.name === "string"
    && typeof value.email === "string";
}
