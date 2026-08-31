import type { OperationBatch, Proposal } from "../shared/contracts";
import { actionLabel, proposedActionLabel } from "./format";

/**
 * The server records what an operation did, not who asked for it. The browser
 * is the only place that knows, so batches applied through WebMCP are tagged
 * here as they happen; anything else stays unattributed rather than guessed.
 */
export type Actor = "assistant" | "you" | "unattributed";

const storageKey = "postreeve.assistant-batches.v1";

function readTagged(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

const assistantBatches = readTagged();
const userBatches = new Set<string>();

export function recordAssistantBatch(batchId: string): void {
  assistantBatches.add(batchId);
  try {
    localStorage.setItem(storageKey, JSON.stringify([...assistantBatches].slice(-500)));
  } catch {
    // Attribution stays in memory for this session when storage is unavailable.
  }
}

export function recordUserBatch(batchId: string): void {
  userBatches.add(batchId);
}

export function actorOf(batchId: string): Actor {
  if (assistantBatches.has(batchId)) return "assistant";
  if (userBatches.has(batchId)) return "you";
  return "unattributed";
}

export const actorMarks: Record<Actor, string> = { assistant: "◆", you: "–", unattributed: "·" };

export interface MessageProvenance {
  readonly kind: "applied" | "proposed";
  readonly mark: string;
  readonly lead: string;
  readonly batchId: string | null;
  readonly proposalId: string | null;
}

function refKey(ref: { accountId: string; mailbox: string; uidValidity: string; uid: number }): string {
  return `${ref.accountId}:${ref.mailbox}:${ref.uidValidity}:${ref.uid}`;
}

/**
 * Newest-first batches and open proposals collapse into one line per message:
 * a pending proposal outranks history, because it is the thing awaiting a decision.
 */
export function buildProvenance(
  batches: readonly OperationBatch[],
  proposals: readonly Proposal[],
): Map<string, MessageProvenance> {
  const provenance = new Map<string, MessageProvenance>();
  const ordered = [...batches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const batch of ordered) {
    if (batch.status === "undone") continue;
    for (const operation of batch.operations) {
      if (operation.status !== "applied") continue;
      const key = refKey(operation.message);
      if (provenance.has(key)) continue;
      const actor = actorOf(batch.id);
      provenance.set(key, {
        kind: "applied",
        mark: actorMarks[actor],
        lead: `${actor === "assistant" ? "assistant " : actor === "you" ? "you " : ""}${actionLabel(operation.action)}`,
        batchId: batch.id,
        proposalId: null,
      });
    }
  }
  for (const proposal of proposals) {
    if (proposal.status !== "draft" && proposal.status !== "review" && proposal.status !== "approved") continue;
    for (const item of proposal.items) {
      provenance.set(refKey(item.message), {
        kind: "proposed",
        mark: "◇",
        lead: `proposes ${proposedActionLabel(item.action)}`,
        batchId: null,
        proposalId: proposal.id,
      });
    }
  }
  return provenance;
}

export function provenanceKey(ref: { accountId: string; mailbox: string; uidValidity: string; uid: number }): string {
  return refKey(ref);
}
