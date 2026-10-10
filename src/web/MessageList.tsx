import type { Folder, MessageSummary, TriageAction } from "../shared/contracts";
import type { MessageFilter, MessageSort } from "./mail-ui-state";
import { formatListTime } from "./format";
import { messageIsSelected, messageKey, messageMatchesKey, planFolderAction, senderName, spamToggle, type FolderIntent } from "./mail-view";
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
  /** Archive and Spam resolve their destination from each selected message's own account. */
  foldersByAccount: ReadonlyMap<string, readonly Folder[]>;
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
  pageSize?: number;
  coverageText?: string | null;
  busy: boolean;
  onSort: (sort: MessageSort) => void;
  onOpen: (message: MessageSummary) => void;
  onSelect: (message: MessageSummary, modifiers: { toggle: boolean; range: boolean }) => void;
  onBulk: (action: TriageAction) => void;
  onFolderAction: (intent: FolderIntent) => void;
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
  const selection = props.messages.filter((message) => messageIsSelected(message, props.selected));
  const selectionCount = selection.length;
  const archive = planFolderAction(selection, "archive", props.foldersByAccount);
  const destinations = props.folders.filter((folder) => folder.specialUse !== "trash");
  const hasTrash = props.folders.some((folder) => folder.specialUse === "trash");
  const firstSelected = selection[0];
  const spamLabel = firstSelected ? spamToggle(firstSelected, props.foldersByAccount.get(firstSelected.ref.accountId) ?? []).label : null;
  const spamIntent: FolderIntent = spamLabel === "Not spam" ? "not_spam" : "spam";
  const spam = planFolderAction(selection, spamIntent, props.foldersByAccount);

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
          <button className="chip" disabled={props.busy || archive.items.length === 0} title={archive.items.length === 0 && archive.missingFolder > 0 ? "This account has no Archive folder" : undefined} onClick={() => props.onFolderAction("archive")}>Archive</button>
          {spamLabel ? <button className="chip" disabled={props.busy || spam.items.length === 0} title={spam.items.length === 0 && spam.missingFolder > 0 ? "This account has no Junk folder" : undefined} onClick={() => props.onFolderAction(spamIntent)}>{spamLabel}</button> : null}
          <button className="chip" disabled={props.busy} onClick={() => props.onBulk({ type: "mark_read" })}>Mark read</button>
          <button className="chip" disabled={props.busy} onClick={() => props.onBulk({ type: "mark_unread" })}>Unread</button>
          <button className="chip" disabled={props.busy} onClick={() => props.onBulk({ type: "flag" })}>Flag</button>
          <button className="chip" disabled={props.busy} onClick={() => props.onBulk({ type: "unflag" })}>Unflag</button>
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

    {props.coverageText ? <p role="note" aria-label="Mailbox coverage" className="t-dim" style={{ margin: "8px 24px" }}>{props.coverageText}</p> : null}
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
          className={`row ${message.read ? "" : "unread"} ${messageMatchesKey(message, props.openKey) ? "open" : index === props.focus ? "focus" : messageIsSelected(message, props.selected) ? "cosel" : ""}`}
          aria-current={messageMatchesKey(message, props.openKey) ? "true" : undefined}
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
          <span className="row-mark" style={{ fontSize: proposed ? 10 : 11, lineHeight: 1, color: proposed ? "var(--ink)" : "var(--dim)" }}>{entry?.mark ?? (message.flagged ? <span aria-label="Flagged">⚑</span> : "")}</span>
          <span className="row-lead-wrap">
            {entry ? <span className={`row-lead ${proposed ? "propose" : ""}`}>{entry.lead}{proposed ? "" : " · "}</span> : null}
            {proposed ? null : <span className="row-snippet truncate">{message.preview}</span>}
          </span>
          <span className="row-time t-num">{formatListTime(message.receivedAt)}</span>
        </button>;
      })}

      {props.canLoadMore ? <button className="load-more" disabled={props.busy} onClick={props.onLoadMore}>Load {props.pageSize ?? 50} more</button> : null}
    </div>

    <div className="hintbar">
      <span className="t-dim">click or ↵ open · j k move · x multi-select · ⌘-click add · shift-click range · e archive · ! spam · u unread · s flag · / search · ⌘Z undo</span>
    </div>
  </>;
}
