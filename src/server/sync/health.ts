import type { Account } from "../../shared/contracts";
import type { AccountHealth } from "../../shared/synchronization";
import type { SyncJob } from "./store";

const failureMessages = {
  provider: "The mail provider could not be reached. Check the connection and retry.",
  reauthorization: "The provider rejected account authorization. Reauthorize this account.",
  "invalid-data": "The provider returned inconsistent synchronization data. Retry; if it persists, check provider support.",
} as const;

export function accountHealth(account: Account, job: SyncJob | undefined, connected: boolean,
  now: number, staleAfterMs: number, retainedContentBytes: number): AccountHealth {
  const disconnected = !connected || !job || job.state === "canceled";
  const state: AccountHealth["state"] = disconnected ? "disconnected"
    : job.error === "reauthorization" ? "reauthorization-required"
    : job.error || (job.last_success_at !== null && now - job.last_success_at > staleAfterMs) ? "degraded"
    : job.coverage !== "complete" || job.last_success_at === null ? "catching-up" : "healthy";
  const guidance = state === "disconnected" ? "Check account settings and server configuration, then reconnect or retry."
    : state === "reauthorization-required" ? failureMessages.reauthorization
    : state === "degraded" ? (job?.error ? failureMessages[job.error] : "Synchronization is overdue. Retry to refresh the local index.")
    : state === "catching-up" ? "The local index is still catching up; cached results may be incomplete."
    : "The local index is synchronized.";
  return {
    account, state, coverage: job?.coverage ?? "partial", lastSuccessAt: job?.last_success_at ?? null,
    failure: job?.error && job.error_at !== null ? { kind: job.error, at: job.error_at, message: failureMessages[job.error] } : null,
    guidance, retryAvailable: job?.state !== "running", retainedContentBytes,
    nextAttemptAt: job && !disconnected && (job.state !== "retry" || job.error !== "reauthorization") ? job.due_at : null,
  };
}
