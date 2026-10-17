import type { AgentEvent } from "../shared/agent-access";
import type { OperationBatch, Proposal } from "../shared/contracts";
import { actionLabel, proposedActionLabel } from "./format";

/**
 * The server records who asked only for remote agents (its audit names the batch).
 * For WebMCP and the UI the browser is the only place that knows, so those batches
 * are tagged here as they happen; anything else stays unattributed rather than guessed.
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

/** Batch ID → remote agent name, from the server's audit of remote MCP calls. */
export type AgentBatchNames = ReadonlyMap<string, string>;

export function agentBatchNames(events: readonly AgentEvent[]): AgentBatchNames {
  return new Map(events.flatMap((event) => event.targetKind === "batch" && event.targetId ? [[event.targetId, event.agentName] as const] : []));
}

export function actorOf(batchId: string, agents: AgentBatchNames = new Map()): Actor {
  if (agents.has(batchId) || assistantBatches.has(batchId)) return "assistant";
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
  agents: AgentBatchNames = new Map(),
): Map<string, MessageProvenance> {
  const provenance = new Map<string, MessageProvenance>();
  const ordered = [...batches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const batch of ordered) {
    if (batch.status === "undone") continue;
    for (const operation of batch.operations) {
      if (operation.status !== "applied") continue;
      const key = refKey(operation.message);
      if (provenance.has(key)) continue;
      const actor = actorOf(batch.id, agents);
      const agentName = agents.get(batch.id);
      provenance.set(key, {
        kind: "applied",
        mark: actorMarks[actor],
        lead: `${agentName ? `${agentName} ` : actor === "assistant" ? "assistant " : actor === "you" ? "you " : ""}${actionLabel(operation.action)}`,
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
