import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Account,
  CanonicalMessageDetail,
  CreateAccountInput,
  Draft,
  DraftAttachment,
  DraftContent,
  Folder,
  OutboundAddress,
  SendReceipt,
  UpdateAccountInput,
} from "../shared/contracts";
import { api } from "./api";
import {
  addressList,
  formatDate,
  forwardSubject,
  quotedMessage,
  replySubject,
} from "./format";
import type { ComposeMode, LocalIdentity } from "./mail-ui-state";
import { DraftSaveQueue } from "./draft-state";

export interface ComposeIntent {
  readonly mode: ComposeMode;
  readonly draft?: Draft;
  readonly message?: CanonicalMessageDetail;
}

export function Sheet({ title, meta, onClose, closeDisabled = false, children, footer, onSubmit }: {
  title: string;
  meta?: string | undefined;
  onClose: () => void;
  closeDisabled?: boolean | undefined;
  children: ReactNode;
  footer: ReactNode;
  onSubmit?: ((event: FormEvent) => void) | undefined;
}) {
  const Body = onSubmit ? "form" : "div";
  return <div className="overlay">
    <button className="backdrop" aria-label="Dismiss overlay" disabled={closeDisabled} onClick={closeDisabled ? undefined : onClose} />
    <Body className="sheet" {...(onSubmit ? { onSubmit } : {})}>
      <div className="sheet-head">
        <h2 style={{ fontSize: 13, fontWeight: 600 }}>{title}</h2>
        {meta ? <span className="t-dim">{meta}</span> : null}
        <button type="button" className="btn-quiet" style={{ marginLeft: "auto" }} aria-label={`Close ${title}`} disabled={closeDisabled} onClick={closeDisabled ? undefined : onClose}>Close</button>
      </div>
      <div className="sheet-body">{children}</div>
      <div className="sheet-foot">{footer}</div>
    </Body>
  </div>;
}

function parseRecipientList(value: string): OutboundAddress[] | null {
  if (!value.trim()) return [];
  const addresses = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (addresses.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return null;
  return addresses.map((address) => ({ name: "", address }));
}

function draftRecipientsText(value: Draft["to"]): string {
  return typeof value === "string" ? value : addressList(value);
}

export function DraftsSheet({ drafts, loaded, loading, refreshing, loadError, onClose, onCreate, onOpen, onRemove }: {
  drafts: readonly Draft[];
  loaded: boolean;
  loading: boolean;
  refreshing: boolean;
  loadError: string | null;
  onClose: () => void;
  onCreate: () => void;
  onOpen: (draft: Draft) => void;
  onRemove: (draft: Draft) => Promise<void>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <Sheet
    title="Drafts"
    meta="saved in Postreeve"
    onClose={onClose}
    footer={<><span className="t-dim">Provider synchronization status is shown for each draft.</span><button className="btn push" onClick={onCreate}>New message</button></>}
  >
    {error ? <div className="alert error">{error}</div> : null}
    {loadError ? <div className="alert error">Could not load drafts: {loadError}</div> : null}
    {loading && drafts.length === 0 ? <p className="t-dim" style={{ margin: 0 }}>Loading drafts…</p> : null}
    {refreshing ? <p className="t-dim" style={{ margin: 0 }}>Refreshing drafts…</p> : null}
    {loaded && !loading && !refreshing && !loadError && drafts.length === 0
      ? <p className="t-dim" style={{ margin: 0 }}>No drafts. Start composing and Postreeve will autosave here.</p>
      : null}
    {drafts.map((draft) => <div key={draft.id} style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid var(--div)", padding: "10px 0" }}>
      <button style={{ flex: 1, minWidth: 0 }} onClick={() => onOpen(draft)}>
        <div className="t-ink truncate">{draft.subject || "(No subject)"}</div>
        <div className="t-dim truncate">{draftRecipientsText(draft.to) || "No recipient"} · {formatDate(draft.updatedAt, true)}</div>
        <div className="t-dim truncate">{draft.mirror.status === "synced"
          ? "Saved in Postreeve · mirrored to provider"
          : draft.mirror.status === "pending"
            ? "Saved in Postreeve · awaiting provider synchronization"
            : "Saved in Postreeve · provider mirror needs repair"}</div>
      </button>
      <button className="btn-danger" disabled={removing === draft.id} aria-label={`Delete draft ${draft.subject || "without subject"}`} onClick={() => {
        setRemoving(draft.id);
        setError(null);
        void onRemove(draft).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Draft deletion failed");
        }).finally(() => setRemoving(null));
      }}>{removing === draft.id ? "Deleting…" : "Delete"}</button>
    </div>)}
  </Sheet>;
}

export function IdentitySheet({ account, identities, onChange, onClose }: {
  account: Account;
  identities: readonly LocalIdentity[];
  onChange: (identities: LocalIdentity[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return <Sheet
    title="Identities"
    meta={account.email}
    onClose={onClose}
    footer={<span className="t-dim">Aliases appear in the From selector. Sending from them stays blocked until SMTP identity validation exists.</span>}
  >
    <div>
      <div style={{ display: "flex", gap: 12, borderTop: "1px solid var(--div)", padding: "10px 0" }}>
        <span className="t-ink">{account.name}</span><span className="t-dim">{account.email} · primary</span>
      </div>
      {identities.map((identity) => <div key={identity.id} style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid var(--div)", padding: "10px 0" }}>
        <span className="t-ink">{identity.name}</span><span className="t-dim">{identity.email}</span>
        <button className="btn-danger" style={{ marginLeft: "auto" }} aria-label={`Remove identity ${identity.email}`} onClick={() => onChange(identities.filter(({ id }) => id !== identity.id))}>Remove</button>
      </div>)}
    </div>
    <form
      className="field-grid"
      style={{ alignItems: "end" }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !name.trim()) return;
        onChange([...identities, { id: crypto.randomUUID(), accountId: account.id, name: name.trim(), email: email.trim().toLowerCase() }]);
        setName("");
        setEmail("");
      }}
    >
      <label className="field"><span className="field-label">Display name</span><input className="input" aria-label="Identity name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span className="field-label">Email address</span><input className="input" aria-label="Identity email address" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <button className="chip" disabled={!valid || !name.trim()}>Add identity</button>
    </form>
  </Sheet>;
}

export function FolderSheet({ account, folders, onChange, onClose }: {
  account: Account;
  folders: readonly Folder[];
  onChange: (folders: Folder[], previousPath?: string, nextPath?: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Folder operation failed");
    } finally {
      setBusy(false);
    }
  }

  return <Sheet
    title="Manage folders"
    meta={account.email}
    onClose={onClose}
    footer={<span className="t-dim">{account.kind === "gmail"
      ? "Deleting a custom label removes the label but keeps its messages in Gmail."
      : "IMAP folders must be empty before they can be deleted. Special-use folders stay protected."}</span>}
  >
    {error ? <div className="alert error">{error}</div> : null}
    <div>
      {folders.map((folder) => {
        const custom = folder.specialUse === null;
        const canDelete = custom && (account.kind === "gmail" || folder.total === 0);
        return <div key={folder.path} aria-label={folder.name} role="article" style={{ borderTop: "1px solid var(--div)", padding: "10px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="t-ink truncate">{folder.name}</span>
            <span className="t-dim">{folder.total.toLocaleString()} messages · {custom ? "custom" : folder.specialUse}</span>
            {custom ? <span style={{ display: "flex", gap: 12, marginLeft: "auto" }}>
              <button className="btn-quiet" disabled={busy} onClick={() => { setEditingPath(folder.path); setRenameName(folder.name); setDeletingPath(null); setError(null); }}>Rename</button>
              <button className="btn-danger" disabled={busy || !canDelete} title={canDelete ? undefined : "Move every message out before deleting this IMAP folder"} onClick={() => { setDeletingPath(folder.path); setEditingPath(null); setError(null); }}>Delete</button>
            </span> : <span className="t-dim" style={{ marginLeft: "auto" }}>Protected</span>}
          </div>
          {editingPath === folder.path ? <form
            style={{ display: "flex", alignItems: "end", gap: 10, marginTop: 10 }}
            onSubmit={(event) => {
              event.preventDefault();
              const name = renameName.trim();
              if (!name) return;
              void run(async () => {
                const next = await api.renameFolder({ accountId: account.id, path: folder.path, name });
                onChange(next, folder.path, next.find((candidate) => candidate.name === name)?.path);
                setEditingPath(null);
                setRenameName("");
              });
            }}
          >
            <label className="field" style={{ flex: 1 }}><span className="field-label">New folder name</span><input className="input" autoFocus aria-label={`Rename ${folder.name}`} value={renameName} onChange={(event) => setRenameName(event.target.value)} /></label>
            <button type="button" className="chip" disabled={busy} onClick={() => setEditingPath(null)}>Cancel</button>
            <button className="btn" disabled={busy || !renameName.trim() || renameName.trim() === folder.name}>Save name</button>
          </form> : null}
          {deletingPath === folder.path ? <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
            <span className="t-body">Delete “{folder.name}”? {account.kind === "gmail" ? "Messages keep their other labels." : "Only an empty IMAP folder can be deleted."}</span>
            <button className="chip" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setDeletingPath(null)}>Cancel</button>
            <button className="btn" disabled={busy} onClick={() => void run(async () => {
              onChange(await api.deleteFolder({ accountId: account.id, path: folder.path }), folder.path);
              setDeletingPath(null);
            })}>Delete {folder.name}</button>
          </div> : null}
        </div>;
      })}
    </div>
    <form
      style={{ display: "flex", alignItems: "end", gap: 10, borderTop: "2px solid var(--ink)", paddingTop: 14 }}
      onSubmit={(event) => {
        event.preventDefault();
        const name = newName.trim();
        if (!name) return;
        void run(async () => {
          onChange(await api.createFolder({ accountId: account.id, name }));
          setNewName("");
        });
      }}
    >
      <label className="field" style={{ flex: 1 }}><span className="field-label">New custom folder</span><input className="input" aria-label="New folder name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Receipts, Projects, Keep…" /></label>
      <button className="btn" disabled={busy || !newName.trim()}>Create folder</button>
    </form>
  </Sheet>;
}

export function ComposeModal({ account, identities, intent, onClose, onSaveDraft, onSent }: {
  account: Account;
  identities: readonly LocalIdentity[];
  intent: ComposeIntent;
  onClose: () => void;
  onSaveDraft: (draft: Draft) => void;
  onSent: (draftId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const source = intent.message;
  const saved = intent.draft;
  const [effectiveMode, setEffectiveMode] = useState<ComposeMode>(saved?.mode ?? intent.mode);
  const conversationMode = effectiveMode === "reply" || effectiveMode === "reply_all" || effectiveMode === "forward";
  const conversationSource = saved?.source ?? (source ? {
    canonicalMessageId: source.canonicalId,
    conversationId: source.conversationId,
    ...(source.providerConversationId ? { providerConversationId: source.providerConversationId } : {}),
  } : undefined);
  const ownAddresses = new Set([account.email.toLowerCase()]);
  const replyRecipients = source
    ? (source.replyTo?.length ? source.replyTo : source.from)
      .filter(({ address }) => !ownAddresses.has(address.toLowerCase()))
    : [];
  if (source && replyRecipients.length === 0) {
    replyRecipients.push(...source.to.filter(({ address }) => !ownAddresses.has(address.toLowerCase())));
  }
  const replyRecipientAddresses = new Set(replyRecipients.map(({ address }) => address.toLowerCase()));
  const replyAllCc = source
    ? [...source.to, ...(source.cc ?? [])]
      .map(({ address }) => address)
      .filter((address, index, all) => !ownAddresses.has(address.toLowerCase())
        && !replyRecipientAddresses.has(address.toLowerCase())
        && all.findIndex((candidate) => candidate.toLowerCase() === address.toLowerCase()) === index)
      .join(", ")
    : "";
  const initialBody = source
    ? effectiveMode === "forward"
      ? `\n\n---------- Forwarded message ----------\nFrom: ${addressList(source.from)}\nDate: ${formatDate(source.receivedAt, true)}\nSubject: ${source.subject}\nTo: ${addressList(source.to)}\n\n${source.text}`
      : quotedMessage(source)
    : "";
  const [from, setFrom] = useState(saved?.identity.address ?? account.email);
  const [to, setTo] = useState(saved ? draftRecipientsText(saved.to) : source && effectiveMode !== "forward" ? addressList(replyRecipients) : "");
  const [cc, setCc] = useState(saved ? draftRecipientsText(saved.cc) : effectiveMode === "reply_all" ? replyAllCc : "");
  const [bcc, setBcc] = useState(saved ? draftRecipientsText(saved.bcc) : "");
  const [subject, setSubject] = useState(saved?.subject ?? (source ? effectiveMode === "forward" ? forwardSubject(source.subject) : replySubject(source.subject) : ""));
  const [body, setBody] = useState(saved?.body ?? initialBody);
  const [attachments, setAttachments] = useState<DraftAttachment[]>(saved?.attachments ?? []);
  const savedIdentityOption: LocalIdentity | undefined = saved
    && saved.identity.address !== account.email
    && !identities.some(({ email }) => email === saved.identity.address)
    ? {
        id: `saved:${saved.id}`,
        accountId: account.id,
        name: saved.identity.name,
        email: saved.identity.address,
      }
    : undefined;
  const identityOptions = savedIdentityOption ? [savedIdentityOption, ...identities] : identities;
  const [validationError, setValidationError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SendReceipt | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(saved?.updatedAt ?? null);
  const [mirrorError, setMirrorError] = useState<string | null>(saved?.mirror.status === "failed" ? saved.mirror.error : null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const autosaveTimeout = useRef<number | null>(null);
  const autosaveSuppressed = useRef(false);
  const active = useRef(true);
  const closing = useRef(false);
  const sendStarted = useRef(false);
  const saveSequence = useRef(0);
  const edited = useRef({ from: false, to: false, cc: false, bcc: false });
  const saver = useRef<DraftSaveQueue | null>(null);
  if (!saver.current) saver.current = new DraftSaveQueue(account.id, saved, api.createDraft, api.updateDraft);
  const backendPending = from !== account.email || attachments.length > 0 || (conversationMode && !conversationSource);

  function currentDraft(): DraftContent {
    const selectedIdentity = identityOptions.find((identity) => identity.email === from);
    return {
      mode: effectiveMode === "draft" ? "new" : effectiveMode,
      ...(conversationSource ? { source: conversationSource } : {}),
      identity: saved && !edited.current.from
        ? saved.identity
        : { name: selectedIdentity?.name ?? account.name, address: from },
      to: saved && !edited.current.to ? saved.to : to,
      cc: saved && !edited.current.cc ? saved.cc : cc,
      bcc: saved && !edited.current.bcc ? saved.bcc : bcc,
      subject,
      body,
      attachments,
    };
  }

  async function saveCurrent(force = false): Promise<Draft> {
    const content = currentDraft();
    const current = saver.current!.current;
    if (!force && !saver.current!.isDirty(content) && current) return current;
    const sequence = ++saveSequence.current;
    if (active.current) {
      setSaving(true);
      setSaveError(null);
    }
    try {
      const draft = await saver.current!.save(content);
      onSaveDraft(draft);
      if (active.current) {
        setSavedAt(draft.updatedAt);
        setMirrorError(draft.mirror.status === "failed" ? draft.mirror.error : null);
        setSaveError(null);
        setRecoveryError(null);
      }
      return draft;
    } catch (cause) {
      if (active.current) setSaveError(cause instanceof Error ? cause.message : "Draft save failed");
      throw cause;
    } finally {
      if (active.current && saveSequence.current === sequence) setSaving(false);
    }
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (autosaveSuppressed.current) return;
    if (!saver.current!.isDirty(currentDraft())) return;
    const timeout = window.setTimeout(() => {
      void saveCurrent().catch(() => undefined);
    }, 700);
    autosaveTimeout.current = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (autosaveTimeout.current === timeout) autosaveTimeout.current = null;
    };
  }, [attachments, bcc, body, cc, effectiveMode, from, subject, to]);

  const mutation = useMutation({
    mutationFn: async (content: DraftContent) => {
      sendStarted.current = false;
      const current = saver.current!.current;
      let draft: Draft;
      try {
        draft = !saver.current!.isDirty(content) && current ? current : await saver.current!.save(content);
      } catch (cause) {
        if (active.current) setSaveError(cause instanceof Error ? cause.message : "Draft save failed");
        throw cause;
      }
      if (active.current) {
        setSaveError(null);
        setMirrorError(draft.mirror.status === "failed" ? draft.mirror.error : null);
      }
      onSaveDraft(draft);
      sendStarted.current = true;
      return { receipt: await api.sendDraft(account.id, draft.id, { version: draft.version }), draftId: draft.id };
    },
    onSuccess: async ({ receipt: nextReceipt, draftId }) => {
      setSaveError(null);
      setRecoveryError(null);
      setReceipt(nextReceipt);
      onSent(draftId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages"] }),
        queryClient.invalidateQueries({ queryKey: ["message"] }),
        ...(conversationSource
          ? [queryClient.invalidateQueries({ queryKey: ["conversation", conversationSource.conversationId] })]
          : []),
        queryClient.invalidateQueries({ queryKey: ["folders", account.id] }),
      ]);
    },
    onError: async () => {
      autosaveSuppressed.current = false;
      if (!sendStarted.current) return;
      try {
        const refreshed = await saver.current!.refreshAfterSend(api.draft);
        if (!refreshed) return;
        onSaveDraft(refreshed);
        if (active.current) setRecoveryError(null);
        if (refreshed.delivery.status === "sent") {
          setReceipt(refreshed.delivery.receipt);
          onSent(refreshed.id);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["messages"] }),
            queryClient.invalidateQueries({ queryKey: ["message"] }),
            ...(conversationSource
              ? [queryClient.invalidateQueries({ queryKey: ["conversation", conversationSource.conversationId] })]
              : []),
            queryClient.invalidateQueries({ queryKey: ["folders", account.id] }),
          ]);
        } else if (active.current) {
          setSavedAt(refreshed.updatedAt);
          setMirrorError(refreshed.mirror.status === "failed" ? refreshed.mirror.error : null);
        }
      } catch (cause: unknown) {
        if (active.current) {
          setRecoveryError(cause instanceof Error ? cause.message : "Could not recover the latest send status");
        }
      }
    },
    onSettled: () => {
      sendStarted.current = false;
    },
  });

  async function closeCurrent(): Promise<void> {
    if (mutation.isPending || closing.current) return;
    if (!saver.current!.isDirty(currentDraft())) {
      onClose();
      return;
    }
    closing.current = true;
    if (autosaveTimeout.current !== null) {
      window.clearTimeout(autosaveTimeout.current);
      autosaveTimeout.current = null;
    }
    try {
      await saveCurrent();
      onClose();
    } catch {
      return;
    } finally {
      closing.current = false;
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (backendPending) return;
    const toAddresses = parseRecipientList(to);
    const ccAddresses = parseRecipientList(cc);
    const bccAddresses = parseRecipientList(bcc);
    if (!toAddresses?.length) {
      setValidationError("Enter at least one valid recipient email address.");
      return;
    }
    if (!ccAddresses || !bccAddresses) {
      setValidationError("Cc and Bcc must contain valid comma-separated email addresses.");
      return;
    }
    setValidationError(null);
    autosaveSuppressed.current = true;
    if (autosaveTimeout.current !== null) {
      window.clearTimeout(autosaveTimeout.current);
      autosaveTimeout.current = null;
    }
    mutation.mutate(currentDraft());
  }

  const modeLabel = effectiveMode === "reply_all" ? "Reply all"
    : effectiveMode === "reply" ? "Reply"
    : effectiveMode === "forward" ? "Forward"
    : saved ? "Edit draft" : "New message";

  if (receipt) {
    return <Sheet title="Message sent" meta={account.email} onClose={onClose} footer={<button className="btn push" onClick={onClose}>Done</button>}>
      <p className="t-body" style={{ margin: 0 }}>Accepted for delivery to {receipt.accepted.length} recipient{receipt.accepted.length === 1 ? "" : "s"}.</p>
      {receipt.rejected.length ? <div className="alert error">Rejected: {receipt.rejected.join(", ")}</div> : null}
      {receipt.warning ? <div className="alert">{receipt.warning}</div> : null}
    </Sheet>;
  }

  return <Sheet
    title={modeLabel}
    meta={account.email}
    onClose={() => void closeCurrent()}
    closeDisabled={mutation.isPending}
    onSubmit={submit}
    footer={<>
      <span className="t-dim">{saving
        ? "Saving draft…"
        : saveError
          ? "Draft changes are not saved"
          : savedAt
            ? `Draft saved ${formatDate(savedAt, true)}`
            : "Drafts autosave to the backend"}</span>
      <button type="button" className="chip push" disabled={saving || mutation.isPending} onClick={() => void saveCurrent(true).catch(() => undefined)}>Save draft</button>
      <button className="btn" disabled={mutation.isPending || !body.trim() || backendPending} title={backendPending ? "Backend support is required before this message can be sent" : undefined}>
        {mutation.isPending ? "Sending…" : "Send message"}
      </button>
    </>}
  >
    <label className="field"><span className="field-label">From</span>
      <select className="input" aria-label="From identity" value={from} disabled={mutation.isPending} onChange={(event) => { edited.current.from = true; setFrom(event.target.value); }}>
        <option value={account.email}>{account.email}</option>
        {identityOptions.map((identity) => <option value={identity.email} key={identity.id}>{identity.name} · {identity.email}</option>)}
      </select>
    </label>
    <label className="field"><span className="field-label">To</span><input className="input" autoFocus required aria-label="To" placeholder="person@example.com, team@example.com" value={to} disabled={mutation.isPending} onChange={(event) => { edited.current.to = true; setTo(event.target.value); }} /></label>
    <div className="field-grid">
      <label className="field"><span className="field-label">Cc</span><input className="input" aria-label="Cc" value={cc} disabled={mutation.isPending} onChange={(event) => { edited.current.cc = true; setCc(event.target.value); }} /></label>
      <label className="field"><span className="field-label">Bcc</span><input className="input" aria-label="Bcc" value={bcc} disabled={mutation.isPending} onChange={(event) => { edited.current.bcc = true; setBcc(event.target.value); }} /></label>
    </div>
    <label className="field"><span className="field-label">Subject</span><input className="input" maxLength={998} aria-label="Subject" value={subject} disabled={mutation.isPending} onChange={(event) => setSubject(event.target.value)} /></label>
    <label className="field"><span className="field-label">Message</span><textarea className="input" required rows={12} maxLength={2_000_000} aria-label="Message" value={body} disabled={mutation.isPending} onChange={(event) => setBody(event.target.value)} /></label>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <label className="chip" aria-disabled={mutation.isPending}>Add attachments<input type="file" multiple disabled={mutation.isPending} style={{ display: "none" }} onChange={(event) => setAttachments((current) => [...current, ...[...(event.target.files ?? [])].map((file) => ({ name: file.name, size: file.size, type: file.type }))])} /></label>
      <span className="t-dim">File bytes are not stored yet.</span>
    </div>
    {attachments.map((attachment, index) => <div key={`${attachment.name}:${index}`} style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="t-body">{attachment.name}</span><span className="t-dim">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
      <button type="button" className="btn-danger" style={{ marginLeft: "auto" }} aria-label={`Remove ${attachment.name}`} disabled={mutation.isPending} onClick={() => setAttachments((current) => current.filter((_, candidate) => candidate !== index))}>Remove</button>
    </div>)}
    {backendPending ? <div className="alert"><strong>Sending is unavailable.</strong>{conversationMode && !conversationSource
      ? <> This draft no longer has its source conversation. <button type="button" className="btn-underline" disabled={mutation.isPending} onClick={() => setEffectiveMode("new")}>Convert to a new message</button></>
      : null}{from !== account.email ? " Alternate From identities are not supported yet." : ""}{attachments.length > 0 ? " Attachment delivery is not supported yet." : ""}</div> : null}
    {validationError ? <div className="alert error">{validationError}</div> : null}
    {saveError ? <div className="alert error">Draft not saved: {saveError}. Your form content was kept.</div> : null}
    {!saveError && mirrorError ? <div className="alert">Saved in Postreeve. Provider mirror needs repair: {mirrorError}</div> : null}
    {recoveryError ? <div className="alert error">Send status recovery failed: {recoveryError}. Your form content was kept.</div> : null}
    {mutation.isError ? <div className="alert error">{mutation.error.message}</div> : null}
  </Sheet>;
}

export function AccountSetup({ account, onClose, onSaved, onRemoved }: {
  account: Account | null;
  onClose: () => void;
  onSaved: (account: Account) => void;
  onRemoved: (accountId: string) => void;
}) {
  const accountId = account?.id ?? null;
  const isGmail = account?.kind === "gmail";
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpHostEdited, setSmtpHostEdited] = useState(false);
  const [smtpUsernameEdited, setSmtpUsernameEdited] = useState(false);
  const [smtpPasswordEdited, setSmtpPasswordEdited] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const connectionFieldsComplete = [name, email, host, port, username, smtpHost, smtpPort, smtpUsername]
    .every((value) => value.trim().length > 0)
    && (Boolean(accountId) || Boolean(password && smtpPassword));

  const settingsQuery = useQuery({
    queryKey: ["account-settings", accountId],
    queryFn: ({ signal }) => api.accountSettings(accountId ?? "", signal),
    enabled: Boolean(accountId && !isGmail),
  });
  const googleStatusQuery = useQuery({
    queryKey: ["google-oauth-status"],
    queryFn: ({ signal }) => api.googleOAuthStatus(signal),
    enabled: !accountId,
  });

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings) return;
    setName(settings.name);
    setEmail(settings.email);
    setHost(settings.host);
    setPort(String(settings.port));
    setSecure(settings.secure);
    setUsername(settings.username);
    setSmtpHost(settings.smtpHost);
    setSmtpPort(String(settings.smtpPort));
    setSmtpSecure(settings.smtpSecure);
    setSmtpUsername(settings.smtpUsername);
  }, [settingsQuery.data]);

  function updateInput(): UpdateAccountInput {
    return {
      name: name.trim(), email: email.trim(), host: host.trim(), port: Number(port), secure,
      username: username.trim(), ...(password ? { password } : {}),
      smtpHost: smtpHost.trim(), smtpPort: Number(smtpPort), smtpSecure,
      smtpUsername: smtpUsername.trim(), ...(smtpPassword ? { smtpPassword } : {}),
    };
  }
  function createInput(): CreateAccountInput {
    return { kind: "imap", ...updateInput(), password, smtpPassword };
  }

  const saveMutation = useMutation({
    mutationFn: () => accountId ? api.updateAccount(accountId, updateInput()) : api.createAccount(createInput()),
    onSuccess: (saved) => {
      queryClient.setQueryData<Account[]>(["accounts"], (accounts = []) => accounts.some(({ id }) => id === saved.id)
        ? accounts.map((current) => current.id === saved.id ? saved : current)
        : [...accounts, saved]);
      onSaved(saved);
    },
  });
  const testMutation = useMutation({
    mutationFn: () => accountId ? api.testAccount(accountId, updateInput()) : api.testNewAccount(createInput()),
  });
  const removeMutation = useMutation({
    mutationFn: () => api.removeAccount(accountId ?? ""),
    onSuccess: () => {
      if (!accountId) return;
      queryClient.setQueryData<Account[]>(["accounts"], (accounts = []) => accounts.filter(({ id }) => id !== accountId));
      queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey.includes(accountId) });
      onRemoved(accountId);
    },
  });

  const removalSection = accountId ? <div style={{ borderTop: "2px solid var(--ink)", paddingTop: 14 }}>
    <div className="t-sec" style={{ marginBottom: 8 }}>Remove account</div>
    <p className="t-body" style={{ margin: "0 0 10px", maxWidth: 560 }}>
      This permanently removes its encrypted credentials and local activity history. It does not delete mail from your provider.
    </p>
    {confirmRemoval ? <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="t-body">This cannot be undone.</span>
      <button type="button" className="chip" onClick={() => setConfirmRemoval(false)}>Cancel</button>
      <button type="button" className="btn" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate()}>
        {removeMutation.isPending ? "Removing…" : "Remove account and local history"}
      </button>
    </div> : <button type="button" className="btn-danger" onClick={() => setConfirmRemoval(true)}>Remove account…</button>}
    {removeMutation.isError ? <div className="alert error" style={{ marginTop: 10 }}>{removeMutation.error.message}</div> : null}
  </div> : null;

  return <Sheet
    title={accountId ? "Manage mailbox" : "Connect a mailbox"}
    meta={account?.email}
    onClose={onClose}
    onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}
    footer={isGmail
      ? <button type="button" className="chip push" onClick={onClose}>Done</button>
      : <>
        <span className="t-dim">Credentials stay encrypted on this server and are never returned to the browser.</span>
        <button type="button" className="chip push" disabled={!connectionFieldsComplete || testMutation.isPending || saveMutation.isPending || (Boolean(accountId) && !settingsQuery.isSuccess)} onClick={() => testMutation.mutate()}>
          {testMutation.isPending ? "Testing…" : "Test connection"}
        </button>
        <button className="btn" disabled={!connectionFieldsComplete || saveMutation.isPending || testMutation.isPending || (Boolean(accountId) && !settingsQuery.isSuccess)}>
          {saveMutation.isPending ? "Connecting…" : accountId ? "Save and reconnect" : "Connect account"}
        </button>
      </>}
  >
    {!accountId && googleStatusQuery.data?.configured ? <div style={{ borderBottom: "1px solid var(--div)", paddingBottom: 16 }}>
      <div className="t-sec" style={{ marginBottom: 8 }}>Gmail</div>
      <p className="t-body" style={{ margin: "0 0 10px" }}>Authorize Postreeve through Google. Your Google password never enters Postreeve.</p>
      <a className="btn" href="/api/oauth/google/start">Continue with Google</a>
    </div> : null}

    {isGmail ? <>
      <div>
        <div className="t-sec" style={{ marginBottom: 8 }}>Connected with Google</div>
        <p className="t-body" style={{ margin: "0 0 10px" }}>{account.email}</p>
        <a className="chip" href="/api/oauth/google/start">Reauthorize Google account</a>
      </div>
      {removalSection}
    </> : null}

    {settingsQuery.isError ? <div className="alert error">{settingsQuery.error.message}</div> : null}

    {!isGmail && (!accountId || settingsQuery.isSuccess) ? <>
      <div className="field-grid">
        <label className="field"><span className="field-label">Name</span><input className="input" required value={name} placeholder="Work" onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span className="field-label">Email address</span><input className="input" required type="email" value={email} placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /></label>
      </div>
      <fieldset>
        <legend>Incoming mail (IMAP)</legend>
        <div className="field-grid">
          <label className="field"><span className="field-label">IMAP host</span><input className="input" required value={host} placeholder="imap.example.com" onChange={(event) => { const value = event.target.value; setHost(value); if (!smtpHostEdited) setSmtpHost(value.replace(/^imap\./i, "smtp.")); }} /></label>
          <label className="field"><span className="field-label">Port</span><input className="input" required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label>
        </div>
        <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} /><span>Use a secure TLS connection</span></label>
        <div className="field-grid" style={{ marginTop: 10 }}>
          <label className="field"><span className="field-label">Username</span><input className="input" required autoComplete="username" value={username} onChange={(event) => { const value = event.target.value; setUsername(value); if (!smtpUsernameEdited) setSmtpUsername(value); }} /></label>
          <label className="field"><span className="field-label">Password {accountId ? "(leave blank to keep current)" : ""}</span><input className="input" required={!accountId} type="password" autoComplete="current-password" value={password} onChange={(event) => { const value = event.target.value; setPassword(value); if (!smtpPasswordEdited) setSmtpPassword(value); }} /></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Outgoing mail (SMTP)</legend>
        <p className="t-dim" style={{ margin: "0 0 10px" }}>Prefilled from IMAP. Change any value if your provider uses different SMTP settings.</p>
        <div className="field-grid">
          <label className="field"><span className="field-label">SMTP host</span><input className="input" required value={smtpHost} placeholder="smtp.example.com" onChange={(event) => { setSmtpHostEdited(true); setSmtpHost(event.target.value); }} /></label>
          <label className="field"><span className="field-label">Port</span><input className="input" required type="number" min="1" max="65535" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} /></label>
        </div>
        <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={smtpSecure} onChange={(event) => setSmtpSecure(event.target.checked)} /><span>Use a secure TLS connection</span></label>
        <div className="field-grid" style={{ marginTop: 10 }}>
          <label className="field"><span className="field-label">Username</span><input className="input" required autoComplete="username" value={smtpUsername} onChange={(event) => { setSmtpUsernameEdited(true); setSmtpUsername(event.target.value); }} /></label>
          <label className="field"><span className="field-label">Password {accountId ? "(leave blank to keep current)" : ""}</span><input className="input" required={!accountId} type="password" autoComplete="current-password" value={smtpPassword} onChange={(event) => { setSmtpPasswordEdited(true); setSmtpPassword(event.target.value); }} /></label>
        </div>
      </fieldset>
      {testMutation.isSuccess ? <div className="alert">IMAP and SMTP connections succeeded.</div> : null}
      {testMutation.isError ? <div className="alert error">{testMutation.error.message}</div> : null}
      {saveMutation.isError ? <div className="alert error">{saveMutation.error.message}</div> : null}
      {removalSection}
    </> : null}
  </Sheet>;
}
