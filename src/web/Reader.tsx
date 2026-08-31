import { useState } from "react";
import type { Folder, MessageDetail, TriageAction } from "../shared/contracts";
import { EmailBody } from "./EmailBody";
import {
  additionalDeliveryAddresses,
  formatDate,
  fromAddress,
  recipients,
} from "./format";
import { senderName } from "./mail-view";
import type { MessageProvenance } from "./provenance";
import { railFor } from "./theme";

export interface ReaderProps {
  message: MessageDetail;
  folders: readonly Folder[];
  provenance: MessageProvenance | undefined;
  folderName: string;
  position: string;
  busy: boolean;
  error: string | null;
  canUndo: boolean;
  onClose: () => void;
  onStep: (direction: 1 | -1) => void;
  onAction: (action: TriageAction) => void;
  onAcceptProposal: (proposalId: string) => void;
  onUndo: () => void;
  onCompose: (mode: "reply" | "reply_all" | "forward") => void;
}

export function Reader(props: ReaderProps) {
  const { message } = props;
  const [destination, setDestination] = useState("");
  const deliveredTo = additionalDeliveryAddresses(message);
  const archive = props.folders.find((folder) => folder.specialUse === "archive" && folder.path !== message.ref.mailbox);
  const destinations = props.folders.filter((folder) => folder.path !== message.ref.mailbox && folder.specialUse !== "trash");
  const inTrash = props.folders.some((folder) => folder.path === message.ref.mailbox && folder.specialUse === "trash");
  const hasTrash = props.folders.some((folder) => folder.specialUse === "trash");
  const proposed = props.provenance?.kind === "proposed";

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
        <div className="msghead">
          <div className="msgrail" style={{ background: railFor(message.ref.accountId) }} />
          <div style={{ minWidth: 0 }}>
            <h2 className="msgsubj">{message.subject || "(No subject)"}</h2>
            <div className="msgmeta">
              <span className="t-ink">{senderName(message)}</span>
              <span className="t-body">{fromAddress(message)}</span>
              <span className="t-dim">to {recipients(message)}</span>
              {message.cc?.length ? <span className="t-dim">cc {message.cc.map((address) => address.name || address.address).join(", ")}</span> : null}
              {deliveredTo.length ? <span className="t-dim">delivered to {deliveredTo.join(", ")}</span> : null}
              <span className="t-dim msgdate">{formatDate(message.receivedAt, true)}</span>
            </div>
          </div>
        </div>

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

        {props.error ? <div className="alert error" style={{ marginTop: 16 }}>{props.error}</div> : null}

        <EmailBody
          key={`${message.ref.accountId}:${message.ref.mailbox}:${message.ref.uidValidity}:${message.ref.uid}`}
          html={message.html}
          text={message.text}
          title={message.subject}
        />

        <div className="replybox">
          <button className="replyhint" onClick={() => props.onCompose("reply")}>Reply to {senderName(message).split(" ")[0]}…</button>
          <button className="btn-quiet" onClick={() => props.onCompose("reply_all")}>Reply all</button>
          <button className="btn-quiet" onClick={() => props.onCompose("forward")}>Forward</button>
          <button className="btn" onClick={() => props.onCompose("reply")}>Reply</button>
        </div>
      </div>
    </div>

    <div className="hintbar">
      <span className="t-dim">esc back to list · j k previous and next message · e archive · u unread · ⌘Z undo</span>
    </div>
  </>;
}
