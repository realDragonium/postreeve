import { z } from "zod";
import { messageRefSchema, messageSummarySchema, type MailProviderKind } from "../../shared/contracts";
import type { MailProvider, ProviderMessageSummary } from "./provider";

export const syncScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account") }),
  z.object({ kind: z.literal("mailbox"), mailbox: z.string().min(1).max(1024) }),
]);
export type SyncScope = z.infer<typeof syncScopeSchema>;
export interface SyncAccount { readonly tenantId: string; readonly accountId: string; readonly provider: MailProviderKind }
export interface SyncRequest {
  readonly account: SyncAccount;
  readonly scope: SyncScope;
  readonly cursor: string | null;
  // Each page collection, and the total snapshot seen references, has this limit.
  // The complete serialized page is also capped at 2 MiB by the store.
  readonly limit: number;
  readonly signal: AbortSignal;
}
export interface SyncSnapshot {
  readonly scope: SyncScope;
  readonly generation: string;
  readonly phase: "start" | "continue" | "complete" | "start-and-complete";
  readonly seen: readonly z.infer<typeof messageRefSchema>[];
}
export interface SyncPage {
  readonly messages: readonly ProviderMessageSummary[];
  readonly removed: readonly z.infer<typeof messageRefSchema>[];
  readonly moves?: readonly { readonly previous: z.infer<typeof messageRefSchema>; readonly current: z.infer<typeof messageRefSchema> }[];
  readonly snapshots?: readonly SyncSnapshot[];
  readonly locationSets?: readonly { readonly providerId: string; readonly mailboxes: readonly string[] }[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly coverage: "partial" | "catching-up" | "complete";
}

// A completed page is not proof that every location in its mailbox was observed.
// Only confirmed deltas or a completed snapshot generation may remove locations.
export interface MailSynchronization {
  discoverScopes(account: SyncAccount, signal: AbortSignal): Promise<readonly SyncScope[]>;
  fetchPage(request: SyncRequest): Promise<SyncPage>;
}

export const syncPageSchema = z.object({
  messages: z.array(messageSummarySchema.extend({
    searchBody: z.string().max(32_768).nullable().optional(),
    searchHeaders: z.string().max(32_768).optional(),
    providerConversationId: z.string().min(1).optional(),
    canonicalReceivedAt: z.iso.datetime().nullable().optional(),
    referenceSequences: z.array(z.array(z.string())).optional(),
  })),
  removed: z.array(messageRefSchema),
  moves: z.array(z.object({ previous: messageRefSchema, current: messageRefSchema })).default([]),
  snapshots: z.array(z.object({
    scope: syncScopeSchema, generation: z.string().min(1).max(200),
    phase: z.enum(["start", "continue", "complete", "start-and-complete"]), seen: z.array(messageRefSchema),
  })).default([]),
  locationSets: z.array(z.object({ providerId: z.string().min(1), mailboxes: z.array(z.string().min(1).max(1024)) })).default([]),
  cursor: z.string().max(64 * 1024).nullable(),
  hasMore: z.boolean(), coverage: z.enum(["partial", "catching-up", "complete"]),
});

export function syncScopeKey(scope: SyncScope): string {
  return JSON.stringify(syncScopeSchema.parse(scope));
}

export function additiveSynchronization(provider: MailProvider): MailSynchronization {
  return {
    async discoverScopes(account, signal) {
      signal.throwIfAborted();
      const folders = await provider.listFolders(account.accountId);
      signal.throwIfAborted();
      return folders.map(({ path }) => ({ kind: "mailbox" as const, mailbox: path }));
    },
    async fetchPage({ account, scope, limit, signal }) {
      signal.throwIfAborted();
      if (scope.kind !== "mailbox") throw new Error("Compatibility synchronization requires a mailbox");
      const page = await provider.listMessagePage(account.accountId, scope.mailbox, limit);
      signal.throwIfAborted();
      return { messages: page.messages, removed: [], cursor: null, hasMore: false, coverage: "partial" };
    },
  };
}

export type SyncFailureKind = "provider" | "reauthorization" | "invalid-data";
export class SynchronizationError extends Error {
  constructor(readonly kind: SyncFailureKind) { super(`Synchronization failed: ${kind}`); }
}
