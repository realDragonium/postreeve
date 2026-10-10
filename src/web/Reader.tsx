import { useEffect, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CanonicalMessageDetail, Folder, MessageSummary, ReceivedAttachment, TriageAction } from "../shared/contracts";
import { api } from "./api";
import { initiallyExpanded } from "./conversation-view";
import { EmailBody } from "./EmailBody";
import {
  additionalDeliveryAddresses,
  formatDate,
  fromAddress,
  recipients,
} from "./format";
import { messageKey, senderName } from "./mail-view";
import type { MessageProvenance } from "./provenance";
import { railFor } from "./theme";

type ComposeFromMode = "reply" | "reply_all" | "forward";

export interface ReaderProps {
  message: MessageSummary;
  thread: readonly MessageSummary[];
  folders: readonly Folder[];
  provenance: MessageProvenance | undefined;
  folderName: string;
  position: string;
  busy: boolean;
  canUndo: boolean;
  onClose: () => void;
  onStep: (direction: 1 | -1) => void;
  onAction: (action: TriageAction) => void;
  onAcceptProposal: (proposalId: string) => void;
  onUndo: () => void;
  onCompose: (mode: ComposeFromMode, source: CanonicalMessageDetail) => void;
  onDownloadAttachment: (accountId: string, attachment: ReceivedAttachment) => Promise<void>;
}

export function Reader(props: ReaderProps) {
  const { message } = props;
  const [destination, setDestination] = useState("");
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const openedRef = useRef<HTMLElement>(null);
  const initial = initiallyExpanded(props.thread, message);
  const archive = props.folders.find((folder) => folder.specialUse === "archive" && folder.path !== message.ref.mailbox);
  const destinations = props.folders.filter((folder) => folder.path !== message.ref.mailbox && folder.specialUse !== "trash");
  const inTrash = props.folders.some((folder) => folder.path === message.ref.mailbox && folder.specialUse === "trash");
  const hasTrash = props.folders.some((folder) => folder.specialUse === "trash");
  const proposed = props.provenance?.kind === "proposed";

  useEffect(() => {
    if (props.thread.length > 1) openedRef.current?.scrollIntoView({ block: "start" });
  }, [props.thread.length]);

  return <>
    <div className="toolbar">
      <button className="btn-underline" style={{ border: 0 }} onClick={props.onClose}>← {props.folderName}</button>
      <span className="t-dim t-num">{props.position}</span>
      <span style={{ display: "flex", gap: 14 }}>
        <button className="btn-quiet" onClick={() => props.onStep(-1)}>Previous</button>
        <button className="btn-quiet" onClick={() => props.onStep(1)}>Next</button>
      </span>
      <span className="toolbar-end">
        <button className="chip" disabled={props.busy || !archive} title={archive ? undefined : "This account has no Archive folder"} onClick={() => archive && props.onAction({ type: "move", destination: archive.path })}>Archive</button>
        <button className="chip" disabled={props.busy} onClick={() => props.onAction({ type: message.read ? "mark_unread" : "mark_read" })}>{message.read ? "Mark unread" : "Mark read"}</button>
        <select
          className="input"
          style={{ width: "auto", height: 26 }}
          aria-label="Move message to"
          value={destination}
          disabled={props.busy || destinations.length === 0}
          onChange={(event) => {
            setDestination("");
            if (event.target.value) props.onAction({ type: "move", destination: event.target.value });
          }}
        >
          <option value="">Move to…</option>
          {destinations.map((folder) => <option key={folder.path} value={folder.path}>{folder.name}</option>)}
        </select>
        <button className="chip" disabled={props.busy || inTrash || !hasTrash} onClick={() => props.onAction({ type: "trash" })}>{inTrash ? "In Trash" : "Trash"}</button>
      </span>
    </div>

    <div className="readscroll">
      <div className="readinner">
        <h2 className="msgsubj">{message.subject || "(No subject)"}</h2>
        {props.thread.length > 1 ? <div className="t-dim t-num" style={{ fontSize: 11, paddingLeft: 14, marginBottom: 8 }}>{props.thread.length} messages</div> : null}

        {props.provenance ? <div className={`provstrip ${proposed ? "propose" : ""}`}>
          <span style={{ fontSize: proposed ? 10 : 11, lineHeight: 1, color: proposed ? "var(--ink)" : "var(--mid)" }}>{props.provenance.mark}</span>
          <span style={{ fontSize: 11, fontWeight: proposed ? 500 : 400, color: proposed ? "var(--ink)" : "var(--mid)" }}>
            {proposed ? `The assistant ${props.provenance.lead} — waiting on you` : props.provenance.lead}
          </span>
          <span className="provstrip-end">
            {!proposed && props.provenance.batchId && props.canUndo ? <button className="btn-underline" onClick={props.onUndo}>Undo</button> : null}
            {proposed && props.provenance.proposalId ? <button className="chip" disabled={props.busy} onClick={() => props.onAcceptProposal(props.provenance!.proposalId!)}>Accept</button> : null}
          </span>
        </div> : null}

        {props.thread.map((entry) => {
          const key = messageKey(entry);
          const expanded = toggled.get(key) ?? initial.has(key);
          return <ConversationMessage
            key={key}
            ref={entry === message ? openedRef : undefined}
            message={entry}
            expanded={expanded}
            onToggle={() => setToggled((current) => new Map(current).set(key, !expanded))}
            onCompose={props.onCompose}
            onDownloadAttachment={props.onDownloadAttachment}
          />;
        })}
      </div>
    </div>

    <div className="hintbar">
      <span className="t-dim">esc back to list · j k previous and next message · e archive · u unread · ⌘Z undo</span>
    </div>
  </>;
}

function ConversationMessage(props: {
  ref: Ref<HTMLElement> | undefined;
  message: MessageSummary;
  expanded: boolean;
  onToggle: () => void;
  onCompose: ReaderProps["onCompose"];
  onDownloadAttachment: ReaderProps["onDownloadAttachment"];
}) {
  const { message, expanded } = props;
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const detailQuery = useQuery({
    queryKey: ["message", messageKey(message), message.ref],
    queryFn: async () => (await api.readMessages([message.ref]))[0] ?? null,
    enabled: expanded,
  });
  const detail = detailQuery.data;
  const deliveredTo = additionalDeliveryAddresses(message);
  const sender = senderName(message);

  return <article ref={props.ref} className="convmsg" aria-label={`Message from ${sender}`}>
    <button className="msghead convhead" aria-expanded={expanded} onClick={props.onToggle}>
      <div className="msgrail" style={{ background: railFor(message.ref.accountId) }} />
      <div className="msgmeta">
        <span className="t-ink">{sender}</span>
        {expanded ? <>
          <span className="t-body">{fromAddress(message)}</span>
          <span className="t-dim">to {recipients(message)}</span>
          {message.cc?.length ? <span className="t-dim">cc {message.cc.map((address) => address.name || address.address).join(", ")}</span> : null}
          {deliveredTo.length ? <span className="t-dim">delivered to {deliveredTo.join(", ")}</span> : null}
        </> : <span className="t-dim convpreview">{message.preview}</span>}
        <span className="t-dim msgdate">{formatDate(message.receivedAt, true)}</span>
      </div>
    </button>

    {expanded ? <>
      {detailQuery.isError ? <div className="alert error" role="alert" style={{ marginTop: 16 }}>{detailQuery.error.message}</div> : null}
      {!detail && !detailQuery.isError ? <div className="t-dim" style={{ marginTop: 16 }}>Loading message…</div> : null}

      {detail && detail.attachments.length > 0 ? <section aria-label="Attachments" style={{ marginTop: 18 }}>
        <div className="t-dim" style={{ fontSize: 11, marginBottom: 8 }}>Attachments</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {detail.attachments.map((attachment) => <button
            key={attachment.reference}
            className="chip"
            disabled={downloading !== null}
            onClick={() => {
              setDownloading(attachment.reference);
              setDownloadError(null);
              void props.onDownloadAttachment(message.ref.accountId, attachment)
                .catch((error: unknown) => setDownloadError(
                  error instanceof Error ? error.message : "Attachment download failed",
                ))
                .finally(() => setDownloading(null));
            }}
          >
            {downloading === attachment.reference ? "Downloading…" : `Download ${attachment.filename}`}
            <span className="t-dim"> · {attachment.sizeIsEstimate ? "~" : ""}{formatAttachmentSize(attachment.size)}</span>
          </button>)}
        </div>
        {downloadError ? <div className="alert error" role="alert" style={{ marginTop: 8 }}>{downloadError}</div> : null}
      </section> : null}

      {detail ? <>
        <EmailBody
          key={`${detail.ref.accountId}:${detail.ref.mailbox}:${detail.ref.uidValidity}:${detail.ref.uid}`}
          html={detail.html}
          text={detail.text}
          title={detail.subject}
        />
        <div className="replybox">
          <button className="replyhint" onClick={() => props.onCompose("reply", detail)}>Reply to {sender.split(" ")[0]}…</button>
          <button className="btn-quiet" onClick={() => props.onCompose("reply_all", detail)}>Reply all</button>
          <button className="btn-quiet" onClick={() => props.onCompose("forward", detail)}>Forward</button>
          <button className="btn" onClick={() => props.onCompose("reply", detail)}>Reply</button>
        </div>
      </> : null}
    </> : null}
  </article>;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
