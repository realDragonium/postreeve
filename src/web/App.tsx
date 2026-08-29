import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import {
  type CreateAccountInput,
  type Folder,
  type MessageDetail,
  type MessageSummary,
  type OperationBatch,
  type OutboundAddress,
  type Proposal,
  type ProposalItem,
  type TriageAction,
  type SendReceipt,
} from "../shared/contracts";
import { api } from "./api";
import { registerPostreeveWebMcp } from "../server/webmcp/register";
import { webMcpServices } from "./webmcp";

type Panel = "proposal" | "history" | null;

const actionLabels: Record<TriageAction["type"], string> = {
  leave: "Leave here",
  move: "Move to folder",
  trash: "Move to Trash",
  mark_read: "Mark as read",
  mark_unread: "Mark as unread",
};

const finalProposalStatuses = new Set<Proposal["status"]>([
  "applied",
  "partially_applied",
  "failed",
  "undone",
  "partially_undone",
]);

function Icon({ name }: { name: "archive" | "chevron" | "history" | "inbox" | "mail" | "menu" | "plus" | "search" | "send" | "sparkles" | "trash" | "x" }) {
  const paths: Record<typeof name, ReactNode> = {
    archive: <><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    inbox: <><path d="M4 4h16v14H4z"/><path d="m4 13 4-4h8l4 4M8 13h8"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z"/><path d="m6 14 .8 2.2L9 17l-2.2.8L6 20l-.8-2.2L3 17l2.2-.8zM18 14l.6 1.4L20 16l-1.4.6L18 18l-.6-1.4L16 16l1.4-.6z"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
    x: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "P";
}

function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown date";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function sender(message: MessageSummary): string {
  const first = message.from[0];
  return first?.name || first?.address || "Unknown sender";
}

function addresses(message: MessageSummary): string {
  return message.to.map((address) => address.name || address.address).join(", ") || "me";
}

function folderIcon(folder: Folder): "archive" | "inbox" | "mail" | "trash" {
  if (folder.specialUse === "inbox") return "inbox";
  if (folder.specialUse === "trash") return "trash";
  if (folder.specialUse === "archive") return "archive";
  return "mail";
}

function parseActionType(value: string): TriageAction["type"] | null {
  switch (value) {
    case "leave":
    case "move":
    case "trash":
    case "mark_read":
    case "mark_unread":
      return value;
    default:
      return null;
  }
}

function sanitizeEmailHtml(html: string): { html: string; blockedImages: number } {
  const cleaned = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "svg", "math", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style", "srcset"],
  });
  const document = new DOMParser().parseFromString(cleaned, "text/html");
  const images = [...document.querySelectorAll("img")];
  for (const image of images) {
    image.removeAttribute("src");
    image.removeAttribute("srcset");
    image.setAttribute("alt", image.getAttribute("alt") || "Remote image blocked");
    image.classList.add("blocked-email-image");
  }
  for (const anchor of document.querySelectorAll("a")) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noreferrer noopener");
  }
  return { html: document.body.innerHTML, blockedImages: images.length };
}

function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state-card error-state"><strong>Something went wrong</strong><p>{message}</p>{retry ? <button className="text-button" onClick={retry}>Try again</button> : null}</div>;
}

function EmptyState({ icon, title, body }: { icon: "history" | "inbox" | "mail" | "sparkles"; title: string; body: string }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} /></span><strong>{title}</strong><p>{body}</p></div>;
}

function StatusPill({ status }: { status: Proposal["status"] | OperationBatch["status"] }) {
  return <span className={`status-pill status-${status}`}>{status.replaceAll("_", " ")}</span>;
}

function App() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [accountSetup, setAccountSetup] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [mailNotice, setMailNotice] = useState<string | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState("");

  useEffect(() => {
    let active = true;
    let dispose = (): void => undefined;
    void registerPostreeveWebMcp(webMcpServices).then((registration) => {
      if (!registration) return;
      if (active) dispose = () => registration.dispose();
      else registration.dispose();
    });
    return () => {
      active = false;
      dispose();
    };
  }, []);

  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: ({ signal }) => api.accounts(signal) });
  useEffect(() => {
    if (!accountId && accountsQuery.data?.[0]) setAccountId(accountsQuery.data[0].id);
  }, [accountId, accountsQuery.data]);

  const foldersQuery = useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => api.folders(accountId),
    enabled: Boolean(accountId),
  });
  useEffect(() => {
    if (!foldersQuery.data?.length) return;
    const exists = foldersQuery.data.some((folder) => folder.path === mailbox);
    if (!exists) setMailbox((foldersQuery.data.find((folder) => folder.specialUse === "inbox") ?? foldersQuery.data[0])?.path ?? "");
  }, [foldersQuery.data, mailbox]);

  const messagesQuery = useQuery({
    queryKey: ["messages", accountId, mailbox, query],
    queryFn: () => api.messages(accountId, mailbox, query),
    enabled: Boolean(accountId && mailbox),
  });
  const selectedMessage = messagesQuery.data?.find((message) => message.ref.uid === selectedUid) ?? null;
  const messageQuery = useQuery({
    queryKey: ["message", accountId, mailbox, selectedUid],
    queryFn: async () => (await api.readMessages(selectedMessage ? [selectedMessage.ref] : []))[0] ?? null,
    enabled: Boolean(selectedMessage),
  });

  const proposalsQuery = useQuery({
    queryKey: ["proposals", accountId],
    queryFn: () => api.proposals(accountId),
    enabled: Boolean(accountId),
  });
  useEffect(() => {
    const proposals = proposalsQuery.data;
    if (!proposals?.length) {
      setSelectedProposalId("");
      return;
    }
    if (!proposals.some((proposal) => proposal.id === selectedProposalId)) {
      setSelectedProposalId((proposals.find((proposal) => !finalProposalStatuses.has(proposal.status)) ?? proposals[0])?.id ?? "");
    }
  }, [proposalsQuery.data, selectedProposalId]);
  const selectedProposal = proposalsQuery.data?.find((proposal) => proposal.id === selectedProposalId) ?? null;

  const batchesQuery = useQuery({
    queryKey: ["batches", accountId],
    queryFn: () => api.batches(accountId),
    enabled: Boolean(accountId && panel === "history"),
  });

  const currentFolder = foldersQuery.data?.find((folder) => folder.path === mailbox);
  const currentAccount = accountsQuery.data?.find((account) => account.id === accountId);

  function switchAccount(next: string): void {
    setAccountId(next);
    setMailbox("");
    setSelectedUid(null);
    setQuery("");
    setQueryDraft("");
    setSelectedProposalId("");
    setComposeOpen(false);
  }

  function selectFolder(path: string): void {
    setMailbox(path);
    setSelectedUid(null);
    setMobileNav(false);
  }

  function search(event: FormEvent): void {
    event.preventDefault();
    setQuery(queryDraft.trim());
    setSelectedUid(null);
  }

  async function refreshWorkflow(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["proposals", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["batches", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["messages", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["folders", accountId] }),
    ]);
  }

  const directActionMutation = useMutation({
    mutationFn: ({ message, subject, action }: { message: MessageDetail; subject: string; action: TriageAction }) =>
      api.applyDirectActions({
        accountId: message.ref.accountId,
        items: [{ message: message.ref, subject, action }],
      }),
    onSuccess: async (_batch, variables) => {
      const label = variables.action.type === "move"
        ? `Moved to ${variables.action.destination}.`
        : variables.action.type === "trash"
          ? "Moved to Trash."
          : variables.action.type === "mark_read"
            ? "Marked as read."
            : "Marked as unread.";
      setMailNotice(label);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", accountId] }),
        queryClient.invalidateQueries({ queryKey: ["message", accountId] }),
        queryClient.invalidateQueries({ queryKey: ["folders", accountId] }),
        queryClient.invalidateQueries({ queryKey: ["batches", accountId] }),
      ]);
      if (variables.action.type === "move" || variables.action.type === "trash") setSelectedUid(null);
    },
  });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Icon name="menu" /></button>
          <a className="brand" href="/" aria-label="Postreeve home"><span className="brand-mark"><Icon name="mail" /></span><span>Postreeve</span></a>
          <span className="early-badge">Early access</span>
        </div>
        <div className="topbar-actions">
          <button className="primary-button compose-button" disabled={!currentAccount} onClick={() => setComposeOpen(true)}><Icon name="plus" /><span>Compose</span></button>
          <button className={`secondary-button ${panel === "history" ? "active" : ""}`} onClick={() => setPanel(panel === "history" ? null : "history")}><Icon name="history" /><span>Activity</span></button>
          <button className={`proposal-button ${panel === "proposal" ? "active" : ""}`} onClick={() => setPanel(panel === "proposal" ? null : "proposal")}>
            <Icon name="sparkles" /><span>Review proposals</span>
            {proposalsQuery.data?.filter((proposal) => proposal.status === "draft" || proposal.status === "review").length ? <span className="count-dot">{proposalsQuery.data.filter((proposal) => proposal.status === "draft" || proposal.status === "review").length}</span> : null}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
          <div className="mobile-sidebar-head"><span>Mailboxes</span><button className="icon-button" aria-label="Close navigation" onClick={() => setMobileNav(false)}><Icon name="x" /></button></div>
          <div className="account-label">Account</div>
          {accountsQuery.isLoading ? <div className="account-skeleton skeleton" /> : accountsQuery.isError ? <ErrorState message={accountsQuery.error.message} retry={() => void accountsQuery.refetch()} /> : (
            <div className="account-picker-wrap">
              <span className="avatar">{initials(currentAccount?.name ?? "P")}</span>
              <select className="account-picker" aria-label="Email account" value={accountId} onChange={(event) => switchAccount(event.target.value)}>
                {accountsQuery.data?.map((account) => <option value={account.id} key={account.id}>{account.name} · {account.email}</option>)}
              </select>
            </div>
          )}
          <button className="add-account" onClick={() => setAccountSetup(true)}><Icon name="plus" /> Add account</button>
          <div className="section-label">Folders</div>
          <nav className="folders" aria-label="Mail folders">
            {foldersQuery.isLoading ? Array.from({ length: 5 }, (_, index) => <div className="folder-skeleton skeleton" key={index} />) : null}
            {foldersQuery.isError ? <ErrorState message={foldersQuery.error.message} retry={() => void foldersQuery.refetch()} /> : null}
            {foldersQuery.data?.map((folder) => (
              <button key={folder.path} className={`folder-row ${folder.path === mailbox ? "active" : ""}`} onClick={() => selectFolder(folder.path)}>
                <Icon name={folderIcon(folder)} /><span>{folder.name}</span>{folder.unread > 0 ? <b>{folder.unread}</b> : null}
              </button>
            ))}
          </nav>
          <div className="sidebar-note"><Icon name="sparkles" /><p><strong>Agent-ready inbox</strong><br />Agents can inspect mail and prepare actions. Only you can approve them.</p></div>
        </aside>
        {mobileNav ? <button className="backdrop nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} /> : null}

        <section className="message-column">
          <div className="mailbox-heading">
            <div><p>{currentAccount?.email ?? "Mailbox"}</p><h1>{currentFolder?.name ?? "Messages"}</h1></div>
            {currentFolder ? <span>{currentFolder.total} messages</span> : null}
          </div>
          <form className="search-box" role="search" onSubmit={search}>
            <Icon name="search" />
            <input aria-label="Search messages" placeholder="Search this folder" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} />
            {queryDraft ? <button type="button" aria-label="Clear search" onClick={() => { setQueryDraft(""); setQuery(""); }}><Icon name="x" /></button> : null}
          </form>
          {query ? <div className="search-context">Results for “{query}” <button onClick={() => { setQuery(""); setQueryDraft(""); }}>Clear</button></div> : null}
          <div className="message-list" aria-label="Messages">
            {messagesQuery.isLoading ? Array.from({ length: 6 }, (_, index) => <div className="message-skeleton" key={index}><span className="skeleton" /><div><i className="skeleton" /><i className="skeleton short" /><i className="skeleton" /></div></div>) : null}
            {messagesQuery.isError ? <ErrorState message={messagesQuery.error.message} retry={() => void messagesQuery.refetch()} /> : null}
            {!messagesQuery.isLoading && !messagesQuery.isError && messagesQuery.data?.length === 0 ? <EmptyState icon="inbox" title={query ? "No matching mail" : "This folder is clear"} body={query ? "Try a broader search." : "New messages will appear here."} /> : null}
            {messagesQuery.data?.map((message) => (
              <button className={`message-row ${selectedUid === message.ref.uid ? "selected" : ""} ${message.read ? "read" : "unread"}`} key={`${message.ref.uidValidity}:${message.ref.uid}`} onClick={() => setSelectedUid(message.ref.uid)}>
                <span className={`sender-avatar tone-${message.ref.uid % 5}`}>{initials(sender(message))}</span>
                <span className="message-copy">
                  <span className="message-meta"><strong>{sender(message)}</strong><time>{formatDate(message.receivedAt)}</time></span>
                  <span className="message-subject">{message.subject || "(No subject)"}</span>
                  <span className="message-preview">{message.preview}</span>
                </span>
                {!message.read ? <span className="unread-dot" aria-label="Unread" /> : null}
              </button>
            ))}
          </div>
        </section>

        <main className="reader">
          {mailNotice ? <div className="mail-toast" role="status">{mailNotice}<button aria-label="Dismiss message" onClick={() => setMailNotice(null)}><Icon name="x" /></button></div> : null}
          {!selectedMessage ? <EmptyState icon="mail" title="Choose a message" body="Select an email to read it here." /> : messageQuery.isLoading ? <ReaderSkeleton /> : messageQuery.isError ? <ErrorState message={messageQuery.error.message} retry={() => void messageQuery.refetch()} /> : messageQuery.data ? <MessageReader
            message={messageQuery.data}
            folders={foldersQuery.data ?? []}
            busy={directActionMutation.isPending}
            error={directActionMutation.error?.message ?? null}
            onAction={(action) => {
              const detail = messageQuery.data;
              if (!detail) return;
              setMailNotice(null);
              directActionMutation.mutate({ message: detail, subject: detail.subject, action });
            }}
            onClose={() => setSelectedUid(null)}
          /> : <EmptyState icon="mail" title="Message unavailable" body="It may have moved since this folder was loaded." />}
        </main>
      </div>

      {panel ? <button className="backdrop panel-backdrop" aria-label="Close panel" onClick={() => setPanel(null)} /> : null}
      <aside className={`workflow-panel ${panel ? "open" : ""}`} aria-hidden={!panel}>
        {panel === "proposal" ? <ProposalPanel
          accountId={accountId}
          folders={foldersQuery.data ?? []}
          proposal={selectedProposal}
          proposals={proposalsQuery.data ?? []}
          loading={proposalsQuery.isLoading}
          error={proposalsQuery.error?.message ?? null}
          onSelect={setSelectedProposalId}
          onClose={() => setPanel(null)}
          onRetry={() => void proposalsQuery.refetch()}
          onRefresh={refreshWorkflow}
        /> : null}
        {panel === "history" ? <HistoryPanel
          batches={batchesQuery.data ?? []}
          loading={batchesQuery.isLoading}
          error={batchesQuery.error?.message ?? null}
          onClose={() => setPanel(null)}
          onRetry={() => void batchesQuery.refetch()}
          onRefresh={refreshWorkflow}
        /> : null}
      </aside>
      {accountSetup ? <AccountSetup onClose={() => setAccountSetup(false)} onCreated={(id) => { setAccountSetup(false); switchAccount(id); }} /> : null}
      {composeOpen && currentAccount ? <ComposeModal account={currentAccount} onClose={() => setComposeOpen(false)} /> : null}
    </div>
  );
}

function ReaderSkeleton() {
  return <div className="reader-skeleton"><i className="skeleton title" /><i className="skeleton line" /><i className="skeleton line short" /><hr /><i className="skeleton line" /><i className="skeleton line" /><i className="skeleton line short" /></div>;
}

function MessageReader({ message, folders, busy, error, onAction, onClose }: {
  message: MessageDetail;
  folders: Folder[];
  busy: boolean;
  error: string | null;
  onAction: (action: TriageAction) => void;
  onClose: () => void;
}) {
  const safe = useMemo(() => message.html ? sanitizeEmailHtml(message.html) : null, [message.html]);
  const [destination, setDestination] = useState("");
  const moveFolders = folders.filter((folder) => folder.path !== message.ref.mailbox && folder.specialUse !== "trash");
  const messageIsInTrash = folders.some((folder) => folder.path === message.ref.mailbox && folder.specialUse === "trash");
  useEffect(() => {
    if (!moveFolders.some((folder) => folder.path === destination)) setDestination(moveFolders[0]?.path ?? "");
  }, [destination, message.ref.mailbox, folders]);
  return <article className="message-reader">
    <button className="mobile-reader-back" onClick={onClose}><Icon name="chevron" /> Back to messages</button>
    <div className="reader-head">
      <div className="reader-labels">{message.read ? <span className="soft-pill">Read</span> : <span className="soft-pill unread">Unread</span>}{message.flagged ? <span className="soft-pill flagged">Flagged</span> : null}</div>
      <div className="reader-actions" aria-label="Message actions">
        <button className="secondary-button" disabled={busy} onClick={() => onAction({ type: message.read ? "mark_unread" : "mark_read" })}>{message.read ? "Mark unread" : "Mark read"}</button>
        <div className="move-control"><select aria-label="Move destination" disabled={busy || moveFolders.length === 0} value={destination} onChange={(event) => setDestination(event.target.value)}>{moveFolders.map((folder) => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select><button className="secondary-button" disabled={busy || !destination} onClick={() => onAction({ type: "move", destination })}>Move</button></div>
        <button className="danger-button" disabled={busy || messageIsInTrash || folders.every((folder) => folder.specialUse !== "trash")} onClick={() => onAction({ type: "trash" })}><Icon name="trash" /> {messageIsInTrash ? "Already in Trash" : "Delete"}</button>
      </div>
      {error ? <div className="inline-alert error reader-action-error">{error}</div> : null}
      <h2>{message.subject || "(No subject)"}</h2>
      <div className="reader-sender">
        <span className={`sender-avatar large tone-${message.ref.uid % 5}`}>{initials(sender(message))}</span>
        <div><strong>{sender(message)}</strong><span>to {addresses(message)}</span></div>
        <time>{formatDate(message.receivedAt, true)}</time>
      </div>
    </div>
    <div className="reader-body">
      {safe ? <>{safe.blockedImages ? <div className="security-note">Remote images blocked to protect your privacy.</div> : null}<div className="email-html" dangerouslySetInnerHTML={{ __html: safe.html }} /></> : <div className="email-text">{message.text}</div>}
    </div>
  </article>;
}

function parseRecipientList(value: string): OutboundAddress[] | null {
  if (!value.trim()) return [];
  const addresses = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (addresses.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return null;
  return addresses.map((address) => ({ name: "", address }));
}

function ComposeModal({ account, onClose }: { account: { id: string; name: string; email: string }; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SendReceipt | null>(null);
  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof api.sendMessage>[0]) => api.sendMessage(input),
    onSuccess: setReceipt,
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
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
    mutation.mutate({ accountId: account.id, to: toAddresses, cc: ccAddresses, bcc: bccAddresses, subject, text: body });
  }
  return <div className="modal-layer compose-layer">
    <button className="backdrop" aria-label="Close compose" disabled={mutation.isPending} onClick={onClose} />
    <form className="account-modal compose-modal" onSubmit={submit}>
      <div className="panel-head"><div><span className="eyebrow"><Icon name="send" /> New message</span><h2>{receipt ? "Message sent" : "Compose email"}</h2></div>{!mutation.isPending ? <button type="button" className="icon-button" aria-label="Close compose" onClick={onClose}><Icon name="x" /></button> : null}</div>
      {receipt ? <div className="compose-success"><span><Icon name="send" /></span><h3>Message sent</h3><p>Accepted for delivery to {receipt.accepted.length} recipient{receipt.accepted.length === 1 ? "" : "s"}.</p>{receipt.rejected.length ? <div className="inline-alert error">Rejected: {receipt.rejected.join(", ")}</div> : null}</div> : <div className="setup-body compose-body">
        <div className="from-field"><span>From</span><strong>{account.name}</strong><small>{account.email}</small></div>
        <label className="field"><span>To</span><input autoFocus required type="text" inputMode="email" aria-label="To" placeholder="person@example.com, team@example.com" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <div className="field-grid"><label className="field"><span>Cc <i>optional</i></span><input type="text" inputMode="email" aria-label="Cc" value={cc} onChange={(event) => setCc(event.target.value)} /></label><label className="field"><span>Bcc <i>optional</i></span><input type="text" inputMode="email" aria-label="Bcc" value={bcc} onChange={(event) => setBcc(event.target.value)} /></label></div>
        <label className="field"><span>Subject</span><input maxLength={998} aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <label className="field"><span>Message</span><textarea required rows={12} maxLength={2_000_000} aria-label="Message" value={body} onChange={(event) => setBody(event.target.value)} /></label>
        {validationError ? <div className="inline-alert error">{validationError}</div> : null}
        {mutation.isError ? <div className="inline-alert error">{mutation.error.message}</div> : null}
      </div>}
      <div className="modal-actions">{receipt ? <button type="button" className="primary-button" onClick={onClose}>Done</button> : <><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onClose}>Cancel</button><button className="primary-button" disabled={mutation.isPending || !body.trim()}><Icon name="send" />{mutation.isPending ? "Sending…" : "Send message"}</button></>}</div>
    </form>
  </div>;
}

interface ProposalPanelProps {
  accountId: string;
  folders: Folder[];
  proposal: Proposal | null;
  proposals: Proposal[];
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onRetry: () => void;
  onRefresh: () => Promise<void>;
}

function ProposalPanel(props: ProposalPanelProps) {
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<ProposalItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  useEffect(() => {
    setTitle(props.proposal?.title ?? "");
    setItems(props.proposal?.items ?? []);
    setMutationError(null);
    setNotice(null);
  }, [props.proposal?.id]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!props.proposal) throw new Error("Choose a proposal first.");
      return api.updateProposal(props.proposal.id, { title, items, status: "review" });
    },
    onSuccess: async () => { setNotice("Changes saved for review."); await props.onRefresh(); },
    onError: (error) => setMutationError(error.message),
  });
  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!props.proposal) throw new Error("Choose a proposal first.");
      await api.updateProposal(props.proposal.id, { title, items, status: "review" });
      return api.approveProposal(props.proposal.id);
    },
    onSuccess: async () => { setNotice("Proposal approved. It has not been applied yet."); await props.onRefresh(); },
    onError: (error) => setMutationError(error.message),
  });
  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!props.proposal) throw new Error("Choose a proposal first.");
      return api.applyProposal(props.proposal.id);
    },
    onSuccess: async () => { setNotice("Approved actions applied. See Activity for results."); await props.onRefresh(); },
    onError: (error) => setMutationError(error.message),
  });

  const editable = props.proposal?.status === "draft" || props.proposal?.status === "review";
  const busy = saveMutation.isPending || approveMutation.isPending || applyMutation.isPending;
  function updateItem(id: string, change: Partial<Pick<ProposalItem, "action" | "reason">>): void {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...change } : item));
    setNotice(null);
  }
  function setAction(item: ProposalItem, type: TriageAction["type"]): void {
    const destination = props.folders.find((folder) => folder.path !== item.message.mailbox && folder.specialUse !== "trash")?.path ?? item.message.mailbox;
    updateItem(item.id, { action: type === "move" ? { type, destination } : { type } });
  }

  return <>
    <div className="panel-head"><div><span className="eyebrow"><Icon name="sparkles" /> Agent proposals</span><h2>Review before anything changes</h2></div><button className="icon-button" aria-label="Close proposal panel" onClick={props.onClose}><Icon name="x" /></button></div>
    <div className="panel-scroll">
      {props.loading ? <ReaderSkeleton /> : props.error ? <ErrorState message={props.error} retry={props.onRetry} /> : props.proposals.length === 0 ? <EmptyState icon="sparkles" title="No proposals yet" body="Connect an agent through WebMCP to prepare a triage plan. It cannot approve actions for you." /> : props.proposal ? <>
        {props.proposals.length > 1 ? <label className="field"><span>Proposal</span><select value={props.proposal.id} onChange={(event) => props.onSelect(event.target.value)}>{props.proposals.map((proposal) => <option key={proposal.id} value={proposal.id}>{proposal.title}</option>)}</select></label> : null}
        <div className="proposal-overview">
          <div className="proposal-title-row"><StatusPill status={props.proposal.status} /><span>{items.length} action{items.length === 1 ? "" : "s"}</span></div>
          <label className="field"><span>Proposal title</span><input aria-label="Proposal title" value={title} disabled={!editable} maxLength={120} onChange={(event) => { setTitle(event.target.value); setNotice(null); }} /></label>
        </div>
        <div className="proposal-items">
          {items.map((item, index) => <div className="proposal-item" key={item.id}>
            <div className="item-index">{index + 1}</div>
            <div className="item-content">
              <div className="item-top"><strong>{item.subject}</strong>{editable && items.length > 1 ? <button className="remove-action" aria-label={`Remove ${item.subject}`} onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}>Remove</button> : null}</div>
              <label className="field compact"><span>Action</span><select aria-label={`Action for ${item.subject}`} disabled={!editable} value={item.action.type} onChange={(event) => { const type = parseActionType(event.target.value); if (type) setAction(item, type); }}>{Object.entries(actionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              {item.action.type === "move" ? <label className="field compact"><span>Destination</span><select aria-label={`Destination for ${item.subject}`} disabled={!editable} value={item.action.destination} onChange={(event) => updateItem(item.id, { action: { type: "move", destination: event.target.value } })}>{props.folders.filter((folder) => folder.specialUse !== "trash").map((folder) => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select></label> : null}
              <label className="field compact"><span>Reason</span><textarea aria-label={`Reason for ${item.subject}`} disabled={!editable} maxLength={500} rows={2} value={item.reason} onChange={(event) => updateItem(item.id, { reason: event.target.value })} /></label>
            </div>
          </div>)}
        </div>
        {mutationError ? <div className="inline-alert error">{mutationError}</div> : null}
        {notice ? <div className="inline-alert success">{notice}</div> : null}
        {editable ? <div className="approval-card"><Icon name="sparkles" /><div><strong>Your approval is required</strong><p>Review every action. Agents cannot approve or apply this proposal.</p></div></div> : null}
      </> : null}
    </div>
    {props.proposal ? <div className="panel-actions">
      {editable ? <><button className="secondary-button wide" disabled={busy || !title.trim() || items.length === 0} onClick={() => { setMutationError(null); saveMutation.mutate(); }}>{saveMutation.isPending ? "Saving…" : "Save changes"}</button><button className="primary-button wide" disabled={busy || !title.trim() || items.length === 0} onClick={() => { setMutationError(null); approveMutation.mutate(); }}>{approveMutation.isPending ? "Approving…" : "Approve proposal"}</button></> : null}
      {props.proposal.status === "approved" ? <><p className="apply-warning">Approved and ready. Applying will change the mailbox.</p><button className="primary-button wide" disabled={busy} onClick={() => { setMutationError(null); applyMutation.mutate(); }}>{applyMutation.isPending ? "Applying actions…" : "Apply approved actions"}</button></> : null}
      {finalProposalStatuses.has(props.proposal.status) ? <p className="finished-note">This proposal is complete. Open Activity to inspect each result or undo supported actions.</p> : null}
    </div> : null}
  </>;
}

interface HistoryPanelProps {
  batches: OperationBatch[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onRefresh: () => Promise<void>;
}

function HistoryPanel(props: HistoryPanelProps) {
  const [undoError, setUndoError] = useState<string | null>(null);
  const undoMutation = useMutation({
    mutationFn: (batchId: string) => api.undoBatch(batchId),
    onSuccess: props.onRefresh,
    onError: (error) => setUndoError(error.message),
  });
  return <>
    <div className="panel-head"><div><span className="eyebrow"><Icon name="history" /> Audit trail</span><h2>Mailbox activity</h2></div><button className="icon-button" aria-label="Close activity panel" onClick={props.onClose}><Icon name="x" /></button></div>
    <div className="panel-scroll history-scroll">
      {props.loading ? <ReaderSkeleton /> : props.error ? <ErrorState message={props.error} retry={props.onRetry} /> : props.batches.length === 0 ? <EmptyState icon="history" title="No activity yet" body="Applied proposals and their individual results will appear here." /> : props.batches.map((batch) => <section className="batch-card" key={batch.id}>
        <div className="batch-head"><div><StatusPill status={batch.status} /><time>{formatDate(batch.updatedAt, true)}</time></div><span>{batch.operations.length} operation{batch.operations.length === 1 ? "" : "s"}</span></div>
        <div className="operation-list">{batch.operations.map((operation) => <div className="operation" key={operation.itemId}><span className={`result-dot ${operation.status}`} /><div><strong>{actionLabels[operation.action.type]}</strong><span>UID {operation.message.uid} · {operation.message.mailbox}</span>{operation.error ? <em>{operation.error}</em> : null}</div><small>{operation.status.replaceAll("_", " ")}</small></div>)}</div>
        {(batch.status === "applied" || batch.status === "partially_applied") ? <button className="secondary-button wide" disabled={undoMutation.isPending} onClick={() => { setUndoError(null); undoMutation.mutate(batch.id); }}>{undoMutation.isPending && undoMutation.variables === batch.id ? "Undoing…" : "Undo supported actions"}</button> : null}
      </section>)}
      {undoError ? <div className="inline-alert error">{undoError}</div> : null}
    </div>
  </>;
}

function AccountSetup({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<"fixture" | "imap">("fixture");
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
  const mutation = useMutation({ mutationFn: api.createAccount, onSuccess: (account) => onCreated(account.id) });
  function submit(event: FormEvent): void {
    event.preventDefault();
    const base = { name: name.trim(), email: email.trim() };
    const input: CreateAccountInput = kind === "fixture" ? { kind, ...base } : {
      kind,
      ...base,
      host: host.trim(),
      port: Number(port),
      secure,
      username: username.trim(),
      password,
      smtpHost: smtpHost.trim(),
      smtpPort: Number(smtpPort),
      smtpSecure,
      smtpUsername: smtpUsername.trim(),
      smtpPassword,
    };
    mutation.mutate(input);
  }
  return <div className="modal-layer"><button className="backdrop" aria-label="Close account setup" onClick={onClose} /><form className="account-modal" onSubmit={submit}>
    <div className="panel-head"><div><span className="eyebrow">Account setup</span><h2>Connect a mailbox</h2></div><button type="button" className="icon-button" aria-label="Close account setup" onClick={onClose}><Icon name="x" /></button></div>
    <div className="setup-body">
      <div className="kind-toggle"><button type="button" className={kind === "fixture" ? "active" : ""} onClick={() => setKind("fixture")}>Demo fixture</button><button type="button" className={kind === "imap" ? "active" : ""} onClick={() => setKind("imap")}>IMAP account</button></div>
      <p className="setup-copy">{kind === "fixture" ? "Add a deterministic demo inbox. No credentials needed." : "Credentials stay on this server and are never sent to the browser again."}</p>
      <div className="field-grid"><label className="field"><span>Name</span><input required value={name} placeholder="Work" onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>Email address</span><input required type="email" value={email} placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /></label></div>
      {kind === "imap" ? <>
        <fieldset className="connection-group"><legend>Incoming mail (IMAP)</legend>
          <div className="field-grid host-grid"><label className="field"><span>IMAP host</span><input required value={host} placeholder="imap.example.com" onChange={(event) => { const value = event.target.value; setHost(value); if (!smtpHostEdited) setSmtpHost(value.replace(/^imap\./i, "smtp.")); }} /></label><label className="field"><span>Port</span><input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label></div>
          <label className="check-field"><input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} /><span>Use a secure TLS connection</span></label>
          <div className="field-grid"><label className="field"><span>Username</span><input required autoComplete="username" value={username} onChange={(event) => { const value = event.target.value; setUsername(value); if (!smtpUsernameEdited) setSmtpUsername(value); }} /></label><label className="field"><span>Password</span><input required type="password" autoComplete="current-password" value={password} onChange={(event) => { const value = event.target.value; setPassword(value); if (!smtpPasswordEdited) setSmtpPassword(value); }} /></label></div>
        </fieldset>
        <fieldset className="connection-group"><legend>Outgoing mail (SMTP)</legend>
          <p className="connection-hint">Prefilled from IMAP. Change any value if your provider uses different SMTP settings.</p>
          <div className="field-grid host-grid"><label className="field"><span>SMTP host</span><input required value={smtpHost} placeholder="smtp.example.com" onChange={(event) => { setSmtpHostEdited(true); setSmtpHost(event.target.value); }} /></label><label className="field"><span>Port</span><input required type="number" min="1" max="65535" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} /></label></div>
          <label className="check-field"><input type="checkbox" checked={smtpSecure} onChange={(event) => setSmtpSecure(event.target.checked)} /><span>Use a secure TLS connection</span></label>
          <div className="field-grid"><label className="field"><span>Username</span><input required autoComplete="username" value={smtpUsername} onChange={(event) => { setSmtpUsernameEdited(true); setSmtpUsername(event.target.value); }} /></label><label className="field"><span>Password</span><input required type="password" autoComplete="current-password" value={smtpPassword} onChange={(event) => { setSmtpPasswordEdited(true); setSmtpPassword(event.target.value); }} /></label></div>
        </fieldset>
      </> : null}
      {mutation.isError ? <div className="inline-alert error">{mutation.error.message}</div> : null}
    </div>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? "Connecting…" : kind === "fixture" ? "Add demo account" : "Connect account"}</button></div>
  </form></div>;
}

export default App;
