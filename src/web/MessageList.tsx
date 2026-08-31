import type { Folder, MessageSummary, TriageAction } from "../shared/contracts";
import type { MessageFilter, MessageSort } from "./mail-ui-state";
import { formatListTime } from "./format";
import { messageKey, senderName } from "./mail-view";
import type { MessageProvenance } from "./provenance";
import { provenanceKey } from "./provenance";
import { railFor } from "./theme";

const sorts: readonly MessageSort[] = ["newest", "oldest", "sender", "subject"];
const sortLabels: Record<MessageSort, string> = { newest: "Newest", oldest: "Oldest", sender: "Sender", subject: "Subject" };

/** The lead column widens to fit the longest proposal line so nothing truncates mid-decision. */
function leadColumnWidth(leads: readonly string[]): number {
  return leads.reduce((widest, lead) => Math.max(widest, Math.min(240, Math.round(lead.length * 5.6) + 16)), 0);
}

export interface MessageListProps {
  messages: readonly MessageSummary[];
  provenance: ReadonlyMap<string, MessageProvenance>;
  folders: readonly Folder[];
  loading: boolean;
  error: string | null;
  focus: number;
  selected: ReadonlySet<string>;
  openKey: string | null;
  title: string;
  countLine: string;
  sort: MessageSort;
  filter: MessageFilter;
  query: string;
  canLoadMore: boolean;
  busy: boolean;
  onSort: (sort: MessageSort) => void;
  onOpen: (message: MessageSummary) => void;
  onSelect: (message: MessageSummary, modifiers: { toggle: boolean; range: boolean }) => void;
  onBulk: (action: TriageAction) => void;
  onAcceptProposal: (proposalId: string) => void;
  onCompose: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

export function MessageList(props: MessageListProps) {
  const leads = props.messages
    .map((message) => props.provenance.get(provenanceKey(message.ref)))
    .filter((entry): entry is MessageProvenance => entry?.kind === "proposed")
    .map((entry) => entry.lead);
  const columns = `2px 14px minmax(96px,168px) minmax(150px,1.3fr) 18px minmax(${leadColumnWidth(leads)}px,1fr) 68px`;

  const focused = props.messages[props.focus];
  const focusedProposal = focused ? props.provenance.get(provenanceKey(focused.ref)) : undefined;
  const selectionCount = props.messages.filter((message) => props.selected.has(messageKey(message))).length;
  const archive = props.folders.find((folder) => folder.specialUse === "archive");
  const destinations = props.folders.filter((folder) => folder.specialUse !== "trash");
  const hasTrash = props.folders.some((folder) => folder.specialUse === "trash");

  return <>
    <div className="scope">
      <span className="scope-title">{props.title}</span>
      <span className="t-dim">{props.countLine}</span>
      <span className="sorts">
        <span className="t-sec">Sort</span>
        {sorts.map((sort) => (
          <button key={sort} className="opt opt-plain" aria-pressed={sort === props.sort} onClick={() => props.onSort(sort)}>
            {sortLabels[sort]}
          </button>
        ))}
      </span>
      <span className="actions">
        {focusedProposal?.kind === "proposed" && focusedProposal.proposalId ? (
          <button className="btn" onClick={() => props.onAcceptProposal(focusedProposal.proposalId!)}>Accept proposal</button>
        ) : null}
        {selectionCount > 0 ? <>
          <button className="chip" disabled={props.busy || !archive} title={archive ? undefined : "This account has no Archive folder"} onClick={() => archive && props.onBulk({ type: "move", destination: archive.path })}>Archive</button>
          <button className="chip" disabled={props.busy} onClick={() => props.onBulk({ type: "mark_read" })}>Mark read</button>
          <button className="chip" disabled={props.busy} onClick={() => props.onBulk({ type: "mark_unread" })}>Unread</button>
          <select
            className="input"
            style={{ width: "auto", height: 26 }}
            aria-label="Move selected messages to"
            value=""
            disabled={props.busy || destinations.length === 0}
            onChange={(event) => { if (event.target.value) props.onBulk({ type: "move", destination: event.target.value }); }}
          >
            <option value="">Move to…</option>
            {destinations.map((folder) => <option key={folder.path} value={folder.path}>{folder.name}</option>)}
          </select>
          <button className="chip" disabled={props.busy || !hasTrash} onClick={() => props.onBulk({ type: "trash" })}>Trash</button>
          <span className="sel-line">{selectionCount} selected</span>
        </> : null}
        <button className="btn" onClick={props.onCompose}>New message</button>
      </span>
    </div>

    <div className="list" aria-label="Messages" style={{ "--row-cols": columns } as React.CSSProperties}>
      {props.loading ? Array.from({ length: 8 }, (_, index) => (
        <div className="row" key={index} style={{ gridTemplateColumns: "2px 14px minmax(96px,168px) minmax(150px,1.3fr)" }}>
          <span /><span /><span className="skeleton" style={{ height: 9, margin: "0 16px 0 10px" }} /><span className="skeleton" style={{ height: 9, marginRight: 24 }} />
        </div>
      )) : null}
      {props.error ? <div className="alert error" style={{ margin: "12px 24px" }}>{props.error} <button className="btn-underline" onClick={props.onRetry}>Try again</button></div> : null}
      {!props.loading && !props.error && props.messages.length === 0 ? (
        <div className="t-dim" style={{ padding: "18px 24px" }}>
          {props.query || props.filter !== "all"
            ? "Nothing matches. Clear the search or switch the filter back to All."
            : "This folder is clear. New messages will appear here."}
        </div>
      ) : null}

      {props.messages.map((message, index) => {
        const key = messageKey(message);
        const entry = props.provenance.get(provenanceKey(message.ref));
        const proposed = entry?.kind === "proposed";
        return <button
          key={key}
          className={`row ${message.read ? "" : "unread"} ${key === props.openKey ? "open" : index === props.focus ? "focus" : props.selected.has(key) ? "cosel" : ""}`}
          aria-current={key === props.openKey ? "true" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) props.onSelect(message, { toggle: true, range: false });
            else if (event.shiftKey) props.onSelect(message, { toggle: false, range: true });
            else props.onOpen(message);
          }}
        >
          <span className="row-rail" style={{ background: railFor(message.ref.accountId) }} />
          <span className={`row-dot ${message.read ? "" : "unread"}`} />
          <span className="row-sender truncate">{senderName(message)}</span>
          <span className="row-subject truncate">{message.subject || "(No subject)"}</span>
          <span className="row-mark" style={{ fontSize: proposed ? 10 : 11, lineHeight: 1, color: proposed ? "var(--ink)" : "var(--dim)" }}>{entry?.mark ?? ""}</span>
          <span className="row-lead-wrap">
            {entry ? <span className={`row-lead ${proposed ? "propose" : ""}`}>{entry.lead}{proposed ? "" : " · "}</span> : null}
            {proposed ? null : <span className="row-snippet truncate">{message.preview}</span>}
          </span>
          <span className="row-time t-num">{formatListTime(message.receivedAt)}</span>
        </button>;
      })}

      {props.canLoadMore ? <button className="load-more" disabled={props.busy} onClick={props.onLoadMore}>Load 50 more</button> : null}
    </div>

    <div className="hintbar">
      <span className="t-dim">click or ↵ open · j k move · x multi-select · ⌘-click add · shift-click range · e archive · u unread · / search · ⌘Z undo</span>
    </div>
  </>;
}
