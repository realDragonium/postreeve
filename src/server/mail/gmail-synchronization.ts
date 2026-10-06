import { z, type ZodType } from "zod";
import type { ProviderMessageSummary } from "./provider";
import { SynchronizationError, type MailSynchronization, type SyncPage, type SyncRequest } from "./synchronization";

export class GmailHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); }
}

interface GmailSynchronizationTransport {
  request<T>(path: string, schema: ZodType<T>, signal: AbortSignal): Promise<T>;
  observe(id: string, signal: AbortSignal): Promise<{
    readonly mailboxes: readonly string[];
    message(mailbox: string): ProviderMessageSummary;
  }>;
}
const idSchema = z.string().min(1);
const historyIdSchema = z.string().regex(/^\d+$/);
const stubSchema = z.object({ id: idSchema });
const changedSchema = z.object({ message: stubSchema });
const historySchema = z.object({
  history: z.array(z.object({
    id: historyIdSchema,
    messages: z.array(stubSchema).default([]),
    messagesAdded: z.array(changedSchema).default([]),
    messagesDeleted: z.array(changedSchema).default([]),
    labelsAdded: z.array(changedSchema).default([]),
    labelsRemoved: z.array(changedSchema).default([]),
  })).default([]),
  nextPageToken: idSchema.optional(),
  historyId: historyIdSchema,
});
const listSchema = z.object({ messages: z.array(stubSchema).default([]), nextPageToken: idSchema.optional() });
const cursorSchema = z.object({
  version: z.literal(1), accountId: idSchema, tenantId: idSchema,
  stage: z.enum(["full", "history"]), historyId: historyIdSchema,
  generation: idSchema.nullable(), pageToken: idSchema.nullable(),
  messageOffset: z.number().int().nonnegative(), labelOffset: z.number().int().nonnegative(),
  pending: z.object({ id: idSchema, nextToken: idSchema.nullable(), historyId: historyIdSchema, moreMessages: z.boolean() }).nullable(),
});
type Cursor = z.infer<typeof cursorSchema>;

export function gmailSynchronization(accountId: string, transport: GmailSynchronizationTransport): MailSynchronization {
  async function begin(request: SyncRequest): Promise<SyncPage> {
    const profile = await transport.request("/profile", z.object({ historyId: historyIdSchema }), request.signal);
    const cursor: Cursor = { version: 1, accountId, tenantId: request.account.tenantId,
      stage: "full", historyId: profile.historyId, generation: crypto.randomUUID(),
      pageToken: null, messageOffset: 0, labelOffset: 0, pending: null };
    return { messages: [], removed: [], cursor: JSON.stringify(cursor), hasMore: true, coverage: "catching-up",
      snapshots: [{ scope: { kind: "account" }, generation: cursor.generation!, phase: "start", seen: [] }] };
  }

  async function fetchPage(request: SyncRequest): Promise<SyncPage> {
    const cursor = parseCursor(request.cursor);
    if (!cursor || cursor.accountId !== accountId || cursor.tenantId !== request.account.tenantId) return begin(request);
    const params = new URLSearchParams({ maxResults: "1" });
    if (cursor.pageToken) params.set("pageToken", cursor.pageToken);
    let ids: string[];
    let nextToken: string | undefined;
    let nextHistory = cursor.historyId;
    try {
      if (cursor.pending) {
        ids = [cursor.pending.id];
        nextToken = cursor.pending.nextToken ?? undefined;
        nextHistory = cursor.pending.historyId;
      } else if (cursor.stage === "full") {
        params.set("includeSpamTrash", "true");
        const listed = await transport.request(`/messages?${params}`, listSchema, request.signal);
        ids = listed.messages.map(message => message.id);
        nextToken = listed.nextPageToken;
      } else {
        params.set("startHistoryId", cursor.historyId);
        const history = await transport.request(`/history?${params}`, historySchema, request.signal);
        // A history record can contain many messages despite maxResults=1.
        ids = [...new Set(history.history.flatMap(record => [
          ...record.messages.map(message => message.id),
          ...record.messagesAdded.map(change => change.message.id),
          ...record.messagesDeleted.map(change => change.message.id),
          ...record.labelsAdded.map(change => change.message.id),
          ...record.labelsRemoved.map(change => change.message.id),
        ]))].sort();
        nextToken = history.nextPageToken;
        nextHistory = history.historyId;
      }
    } catch (error) {
      if (error instanceof GmailHttpError && (error.status === 404 || (error.status === 400 && cursor.pageToken))) return begin(request);
      throw error;
    }

    const providerId = cursor.pending?.id ?? ids[cursor.messageOffset];
    let observation: Awaited<ReturnType<GmailSynchronizationTransport["observe"]>> | null = null;
    if (providerId) {
      try { observation = await transport.observe(providerId, request.signal); }
      catch (error) { if (!(error instanceof GmailHttpError && error.status === 404)) throw error; }
    }
    const current = observation;
    const messages = current ? current.mailboxes.slice(cursor.labelOffset, cursor.labelOffset + request.limit)
      .map(mailbox => current.message(mailbox)) : [];
    const moreLabels = cursor.labelOffset + messages.length < (observation?.mailboxes.length ?? 0);
    const moreMessages = cursor.pending?.moreMessages ?? cursor.messageOffset + 1 < ids.length;
    const next: Cursor = { ...cursor, pending: null };
    let complete = false;
    if (moreLabels && providerId) {
      next.labelOffset += messages.length;
      next.pending = { id: providerId, nextToken: nextToken ?? null, historyId: nextHistory, moreMessages };
    }
    else if (moreMessages) { next.messageOffset++; next.labelOffset = 0; }
    else if (nextToken) {
      if (nextToken === cursor.pageToken) throw new SynchronizationError("invalid-data");
      next.pageToken = nextToken; next.messageOffset = 0; next.labelOffset = 0;
    } else if (cursor.stage === "full") {
      next.stage = "history"; next.pageToken = null; next.messageOffset = 0; next.labelOffset = 0;
    } else {
      next.historyId = nextHistory; next.pageToken = null; next.generation = null;
      next.messageOffset = 0; next.labelOffset = 0; complete = true;
    }
    return {
      messages, removed: [],
      // Apply the exact set only once every new location has been observed.
      locationSets: providerId && !moreLabels ? [{ providerId, mailboxes: observation?.mailboxes ?? [] }] : [],
      snapshots: cursor.generation ? [{ scope: { kind: "account" }, generation: cursor.generation,
        phase: complete ? "complete" : "continue", seen: messages.map(message => message.ref) }] : [],
      cursor: JSON.stringify(next), hasMore: !complete, coverage: complete ? "complete" : "catching-up",
    };
  }

  function assertAccount(account: SyncRequest["account"]): void {
    if (account.accountId !== accountId || account.provider !== "gmail" || !account.tenantId.trim()) {
      throw new SynchronizationError("invalid-data");
    }
  }
  return {
    async discoverScopes(account, signal) { signal.throwIfAborted(); assertAccount(account); return [{ kind: "account" }]; },
    async fetchPage(request) {
      request.signal.throwIfAborted(); assertAccount(request.account);
      if (request.scope.kind !== "account" || !Number.isSafeInteger(request.limit) || request.limit < 1) {
        throw new SynchronizationError("invalid-data");
      }
      try {
        const result = await fetchPage(request);
        request.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (error instanceof GmailHttpError && (error.status === 401 || error.code === "invalid_grant")) {
          throw new SynchronizationError("reauthorization");
        }
        throw error;
      }
    },
  };
}

function parseCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  try { const result = cursorSchema.safeParse(JSON.parse(value)); return result.success ? result.data : null; }
  catch { return null; }
}

export function gmailLocationMailboxes(labels: readonly string[]): string[] {
  const mailboxes = labels.filter(label => !["UNREAD", "STARRED", "IMPORTANT", "CHAT"].includes(label) && !label.startsWith("CATEGORY_"));
  if (!labels.some(label => ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH"].includes(label))) mailboxes.push("__archive__");
  return [...new Set(mailboxes)].sort();
}
