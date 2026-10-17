import type { AgentEvent } from "../shared/agent-access";
import type { Account, OperationBatch } from "../shared/contracts";
import { actionLabel, formatRelative } from "./format";
import { actorMarks, actorOf, agentBatchNames, type Actor } from "./provenance";

const actorFilters: readonly (Actor | "all")[] = ["all", "assistant", "you", "unattributed"];
const actorLabels: Record<Actor | "all", string> = {
  all: "All",
  assistant: "Assistant",
  you: "You",
  unattributed: "Unattributed",
};

const columns = "14px 92px minmax(200px,1.4fr) minmax(140px,1fr) 92px 60px";

export interface ActivityViewProps {
  batches: readonly OperationBatch[];
  /** Remote agent calls from the server's audit; batch calls label batch rows, the rest get rows of their own. */
  agentEvents: readonly AgentEvent[];
  accounts: readonly Account[];
  loading: boolean;
  error: string | null;
  actorFilter: Actor | "all";
  undoing: string | null;
  onActorFilter: (actor: Actor | "all") => void;
  onUndo: (batchId: string) => void;
  onRetry: () => void;
}

export function ActivityView(props: ActivityViewProps) {
  const agents = agentBatchNames(props.agentEvents);
  const batchRows = props.batches.flatMap((batch) => {
    const actor = actorOf(batch.id, agents);
    const undoable = batch.status === "applied" || batch.status === "partially_applied";
    return batch.operations.map((operation, index) => ({
      key: `${batch.id}:${operation.itemId}`,
      batchId: batch.id,
      actor,
      actorLabel: agents.get(batch.id) ?? (actor === "unattributed" ? "—" : actor),
      mark: operation.status === "undone" ? "·" : actorMarks[actor],
      what: actionLabel(operation.action),
      target: `${operation.message.mailbox} · UID ${operation.message.uid}`,
      at: batch.updatedAt,
      status: operation.status,
      error: operation.error,
      undoable: undoable && index === 0,
    }));
  });
  const emails = new Map(props.accounts.map((account) => [account.id, account.email]));
  const eventRows = props.agentEvents.filter((event) => event.targetKind !== "batch").map((event) => ({
    key: `event:${event.id}`,
    batchId: "",
    actor: "assistant" as Actor,
    actorLabel: event.agentName,
    mark: actorMarks.assistant,
    what: `${event.tool}${event.summary ? ` · ${event.summary}` : ""}`,
    target: event.accountId ? emails.get(event.accountId) ?? "removed account" : "—",
    at: event.createdAt,
    status: event.outcome,
    error: event.error,
    undoable: false,
  }));
  const rows = [...batchRows, ...eventRows]
    .sort((left, right) => right.at.localeCompare(left.at))
    .filter((row) => props.actorFilter === "all" || row.actor === props.actorFilter);

  return <>
    <div className="toolbar">
      <span className="scope-title">Activity</span>
      <span className="t-dim">every operation this server applied, newest first</span>
      <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
        {actorFilters.map((actor) => (
          <button key={actor} className="opt" aria-pressed={actor === props.actorFilter} onClick={() => props.onActorFilter(actor)}>
            {actorLabels[actor]}
          </button>
        ))}
      </span>
    </div>

    <div className="readscroll">
      <div className="pad" style={{ "--grid-cols": columns } as React.CSSProperties}>
        <div className="grid-head">
          <span />
          <span className="t-sec">Actor</span>
          <span className="t-sec">Operation</span>
          <span className="t-sec">Message or account</span>
          <span className="t-sec">When</span>
          <span />
        </div>
        <div className="thin" />

        {props.loading ? <div className="t-dim" style={{ padding: "18px 0" }}>Loading activity…</div> : null}
        {props.error ? <div className="alert error" style={{ marginTop: 12 }}>{props.error} <button className="btn-underline" onClick={props.onRetry}>Try again</button></div> : null}
        {!props.loading && !props.error && rows.length === 0 ? (
          <div className="t-dim" style={{ padding: "18px 0" }}>
            Nothing yet. Archive, move or mark a message and every operation lands here, with the actor that called it.
          </div>
        ) : null}

        {rows.map((row) => (
          <div className="grid-row" key={row.key}>
            <span style={{ fontSize: 11, lineHeight: 1, color: "var(--dim)" }}>{row.mark}</span>
            <span className="t-body truncate" style={{ fontWeight: 500 }} title={row.actorLabel}>{row.actorLabel}</span>
            <span className="t-ink truncate" style={{ fontSize: 11, paddingRight: 16 }}>{row.what}{row.status === "undone" ? " (undone)" : ""}{row.error ? ` — ${row.error}` : ""}</span>
            <span className="t-dim truncate" style={{ paddingRight: 16 }}>{row.target}</span>
            <span className="t-dim t-num">{formatRelative(row.at)}</span>
            <span style={{ display: "flex", justifyContent: "flex-end" }}>
              {row.undoable ? (
                <button className="btn-underline" disabled={props.undoing === row.batchId} onClick={() => props.onUndo(row.batchId)}>
                  {props.undoing === row.batchId ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </span>
          </div>
        ))}

        <p className="t-dim" style={{ maxWidth: 760, margin: "20px 0 0" }}>
          Remote agents are named by the server, which records every call they make. Operations this browser sent through
          WebMCP are attributed to the assistant, ones you triggered here to you; anything else from an earlier session stays
          unattributed rather than guessed.
        </p>
      </div>
    </div>
  </>;
}
