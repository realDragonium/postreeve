import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import {
  type Account,
  type CreateAccountInput,
  type UpdateAccountInput,
  type Folder,
  type MessageDetail,
  type MessageSummary,
  type OperationBatch,
  type OutboundAddress,
  type TriageAction,
  type SendReceipt,
} from "../shared/contracts";
import { api } from "./api";
import { registerPostreeveWebMcp } from "../server/webmcp/register";
import { subscribeToWebMcpFolderLists, subscribeToWebMcpMailboxViews, webMcpServices } from "./webmcp";
import {
  loadLocalDrafts,
  loadLocalIdentities,
  storeLocalDrafts,
  storeLocalIdentities,
  type ComposeMode,
  type LocalAttachment,
  type LocalDraft,
  type LocalIdentity,
  type MessageFilter,
  type MessageSort,
} from "./mail-ui-state";

type Panel = "history" | "drafts" | "folders" | "identities" | null;

interface ComposeIntent {
  readonly mode: ComposeMode;
  readonly draft?: LocalDraft;
  readonly message?: MessageDetail;
}

const folderPollIntervalMs = 15_000;

const actionLabels: Record<TriageAction["type"], string> = {
  leave: "Leave here",
  move: "Move to folder",
  trash: "Move to Trash",
  mark_read: "Mark as read",
  mark_unread: "Mark as unread",
};

function Icon({ name }: { name: "archive" | "chevron" | "folder" | "forward" | "history" | "inbox" | "mail" | "menu" | "paperclip" | "plus" | "refresh" | "reply" | "search" | "send" | "sparkles" | "star" | "trash" | "x" }) {
  const paths: Record<typeof name, ReactNode> = {
    archive: <><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    folder: <><path d="M3 6h7l2 2h9v10H3z"/><path d="M3 8h18"/></>,
    forward: <><path d="m15 8 5 4-5 4"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    inbox: <><path d="M4 4h16v14H4z"/><path d="m4 13 4-4h8l4 4M8 13h8"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    paperclip: <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3 3 0 0 1 4 4l-8.5 8.5a1 1 0 0 1-1.5-1.5L15 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.4-2L20 8M4 16l2.5 2A7 7 0 0 0 18 16"/></>,
    reply: <><path d="m9 8-5 4 5 4"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z"/><path d="m6 14 .8 2.2L9 17l-2.2.8L6 20l-.8-2.2L3 17l2.2-.8zM18 14l.6 1.4L20 16l-1.4.6L18 18l-.6-1.4L16 16l1.4-.6z"/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" />,
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

function additionalDeliveryAddresses(message: MessageSummary): string[] {
  const visible = new Set(message.to.map(({ address }) => address.toLowerCase()));
  return (message.deliveredTo ?? []).filter((address) => !visible.has(address.toLowerCase()));
}

function messageKey(message: MessageSummary): string {
  return `${message.ref.mailbox}:${message.ref.uidValidity}:${message.ref.uid}`;
}

function addressList(addresses: readonly { address: string }[]): string {
  return addresses.map(({ address }) => address).join(", ");
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function forwardSubject(subject: string): string {
  return /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function quotedMessage(message: MessageDetail): string {
  const author = message.from[0]?.name || message.from[0]?.address || "Sender";
  const quoted = message.text.split("\n").map((line) => `> ${line}`).join("\n");
  return `\n\nOn ${formatDate(message.receivedAt, true)}, ${author} wrote:\n${quoted}`;
}

function folderIcon(folder: Folder): "archive" | "inbox" | "mail" | "trash" {
  if (folder.specialUse === "inbox") return "inbox";
  if (folder.specialUse === "trash") return "trash";
  if (folder.specialUse === "archive") return "archive";
  return "mail";
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

function StatusPill({ status }: { status: OperationBatch["status"] }) {
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
  const [accountSetup, setAccountSetup] = useState<"new" | string | null>(null);
  const [composeIntent, setComposeIntent] = useState<ComposeIntent | null>(null);
  const [mailNotice, setMailNotice] = useState<string | null>(null);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("all");
  const [messageSort, setMessageSort] = useState<MessageSort>("newest");
  const [messageLimit, setMessageLimit] = useState(50);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<LocalDraft[]>(loadLocalDrafts);
  const [identities, setIdentities] = useState<LocalIdentity[]>(loadLocalIdentities);
  const observedFolderCounts = useRef(new Map<string, string>());

  useEffect(() => storeLocalDrafts(drafts), [drafts]);
  useEffect(() => storeLocalIdentities(identities), [identities]);

  useEffect(() => {
    let active = true;
    let dispose = (): void => undefined;
    const unsubscribe = subscribeToWebMcpMailboxViews((view) => {
      queryClient.setQueryData(
        ["messages", view.accountId, view.mailbox, view.query, view.limit],
        [...view.messages],
      );
      setAccountId(view.accountId);
      setMailbox(view.mailbox);
      setQueryDraft(view.query);
      setQuery(view.query);
      setMessageFilter(view.filter);
      setMessageSort(view.sort);
      setMessageLimit(view.limit);
      setSelectedUid(null);
      setSelectedMessages(new Set());
      setPanel(null);
      setMobileNav(false);
      setMailNotice("WebMCP updated the visible mailbox view.");
    });
    const unsubscribeFolders = subscribeToWebMcpFolderLists((nextAccountId, folders) => {
      queryClient.setQueryData(["folders", nextAccountId], [...folders]);
      setAccountId(nextAccountId);
      setMailbox((current) => folders.some(({ path }) => path === current)
        ? current
        : (folders.find(({ specialUse }) => specialUse === "inbox") ?? folders[0])?.path ?? "");
      setSelectedUid(null);
      setSelectedMessages(new Set());
      setMailNotice("WebMCP updated the folder list.");
    });
    void registerPostreeveWebMcp(webMcpServices).then((registration) => {
      if (!registration) return;
      if (active) dispose = () => registration.dispose();
      else registration.dispose();
    });
    return () => {
      active = false;
      dispose();
      unsubscribe();
      unsubscribeFolders();
    };
  }, [queryClient]);

  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: ({ signal }) => api.accounts(signal) });
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("google");
    if (!result) return;
    if (result === "connected") {
      const connectedAccountId = url.searchParams.get("accountId");
      if (connectedAccountId) setAccountId(connectedAccountId);
      setMailNotice("Google account connected.");
    } else {
      setMailNotice("Google account connection did not complete. Try again.");
    }
    url.searchParams.delete("google");
    url.searchParams.delete("accountId");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => {
    if (!accountId && accountsQuery.data?.[0]) setAccountId(accountsQuery.data[0].id);
  }, [accountId, accountsQuery.data]);

  const foldersQuery = useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => api.folders(accountId),
    enabled: Boolean(accountId),
    refetchInterval: folderPollIntervalMs,
  });
  useEffect(() => {
    if (!foldersQuery.data?.length) return;
    const exists = foldersQuery.data.some((folder) => folder.path === mailbox);
    if (!exists) setMailbox((foldersQuery.data.find((folder) => folder.specialUse === "inbox") ?? foldersQuery.data[0])?.path ?? "");
  }, [foldersQuery.data, mailbox]);

  const messagesQuery = useQuery({
    queryKey: ["messages", accountId, mailbox, query, messageLimit],
    queryFn: () => api.messages(accountId, mailbox, query, messageLimit),
    enabled: Boolean(accountId && mailbox),
  });
  const visibleMessages = useMemo(() => {
    const filtered = (messagesQuery.data ?? []).filter((message) => {
      if (messageFilter === "unread") return !message.read;
      if (messageFilter === "flagged") return message.flagged;
      return true;
    });
    return [...filtered].sort((left, right) => {
      if (messageSort === "oldest") return left.receivedAt.localeCompare(right.receivedAt);
      if (messageSort === "sender") return sender(left).localeCompare(sender(right));
      if (messageSort === "subject") return left.subject.localeCompare(right.subject);
      return right.receivedAt.localeCompare(left.receivedAt);
    });
  }, [messageFilter, messageSort, messagesQuery.data]);
  const selectedMessage = messagesQuery.data?.find((message) => message.ref.uid === selectedUid) ?? null;
  const messageQuery = useQuery({
    queryKey: ["message", accountId, mailbox, selectedUid],
    queryFn: async () => (await api.readMessages(selectedMessage ? [selectedMessage.ref] : []))[0] ?? null,
    enabled: Boolean(selectedMessage),
  });

  const batchesQuery = useQuery({
    queryKey: ["batches", accountId],
    queryFn: () => api.batches(accountId),
    enabled: Boolean(accountId && panel === "history"),
  });

  const currentFolder = foldersQuery.data?.find((folder) => folder.path === mailbox);
  const currentAccount = accountsQuery.data?.find((account) => account.id === accountId);
  const hasAccounts = Boolean(accountsQuery.data?.length);
  const accountDrafts = drafts.filter((draft) => draft.accountId === accountId);
  const accountIdentities = identities.filter((identity) => identity.accountId === accountId);
  useEffect(() => {
    if (!currentFolder) return;
    const key = `${accountId}\n${currentFolder.path}`;
    const counts = `${currentFolder.total}:${currentFolder.unread}`;
    const previous = observedFolderCounts.current.get(key);
    observedFolderCounts.current.set(key, counts);
    if (previous !== undefined && previous !== counts) {
      void queryClient.invalidateQueries({ queryKey: ["messages", accountId, currentFolder.path] });
    }
  }, [accountId, currentFolder, queryClient]);

  function switchAccount(next: string): void {
    setAccountId(next);
    setMailbox("");
    setSelectedUid(null);
    setQuery("");
    setQueryDraft("");
    setComposeIntent(null);
    setSelectedMessages(new Set());
    setMessageLimit(50);
  }

  function selectFolder(path: string): void {
    setMailbox(path);
    setSelectedUid(null);
    setSelectedMessages(new Set());
    setMessageLimit(50);
    setMobileNav(false);
  }

  function search(event: FormEvent): void {
    event.preventDefault();
    setQuery(queryDraft.trim());
    setSelectedUid(null);
    setSelectedMessages(new Set());
    setMessageLimit(50);
  }

  async function refreshMailbox(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["messages", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["folders", accountId] }),
      queryClient.invalidateQueries({ queryKey: ["message", accountId] }),
    ]);
    setMailNotice("Mailbox refreshed.");
  }

  function toggleMessageSelection(message: MessageSummary): void {
    const key = messageKey(message);
    setSelectedMessages((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function saveDraft(draft: LocalDraft): void {
    setDrafts((current) => {
      const exists = current.some(({ id }) => id === draft.id);
      return exists ? current.map((candidate) => candidate.id === draft.id ? draft : candidate) : [draft, ...current];
    });
  }

  function removeDraft(id: string): void {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  }

  async function refreshWorkflow(): Promise<void> {
    await Promise.all([
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

  const bulkActionMutation = useMutation({
    mutationFn: (action: TriageAction) => {
      const messages = (messagesQuery.data ?? []).filter((message) => selectedMessages.has(messageKey(message)));
      return api.applyDirectActions({
        accountId,
        items: messages.map((message) => ({ message: message.ref, subject: message.subject, action })),
      });
    },
    onSuccess: async (_batch, action) => {
      setSelectedMessages(new Set());
      setSelectedUid(null);
      setMailNotice(`${actionLabels[action.type]} applied to selected messages.`);
      await refreshWorkflow();
    },
  });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Icon name="menu" /></button>
          <a className="brand" href="/" aria-label="Postreeve home"><span className="brand-mark"><Icon name="mail" /></span><span>Postreeve</span></a>
        </div>
        <div className="topbar-actions">
          <button className="primary-button compose-button" disabled={!currentAccount} onClick={() => setComposeIntent({ mode: "new" })}><Icon name="plus" /><span>Compose</span></button>
          <button className={`secondary-button ${panel === "history" ? "active" : ""}`} disabled={!currentAccount} onClick={() => setPanel(panel === "history" ? null : "history")}><Icon name="history" /><span>Activity</span></button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
          <div className="mobile-sidebar-head"><span>Mailboxes</span><button className="icon-button" aria-label="Close navigation" onClick={() => setMobileNav(false)}><Icon name="x" /></button></div>
          <div className="account-label">Account</div>
          {accountsQuery.isLoading ? <div className="account-skeleton skeleton" /> : accountsQuery.isError ? <ErrorState message={accountsQuery.error.message} retry={() => void accountsQuery.refetch()} /> : hasAccounts ? (
            <div className="account-picker-wrap">
              <span className="avatar">{initials(currentAccount?.name ?? "P")}</span>
              <select className="account-picker" aria-label="Email account" value={accountId} onChange={(event) => switchAccount(event.target.value)}>
                {accountsQuery.data?.map((account) => <option value={account.id} key={account.id}>{account.name} · {account.email}</option>)}
              </select>
            </div>
          ) : <div className="account-picker-wrap disconnected-account"><span className="avatar"><Icon name="mail" /></span><span>No account connected</span></div>}
          <div className="account-links"><button className="add-account" onClick={() => setAccountSetup("new")}><Icon name="plus" /> Add account</button>{currentAccount ? <><button className="manage-account" onClick={() => setPanel("identities")}>Identities</button><button className="manage-account" onClick={() => setAccountSetup(currentAccount.id)}>Manage</button></> : null}</div>
          <div className="section-label section-label-action"><span>Folders</span>{currentAccount ? <button aria-label="Manage folders" onClick={() => setPanel("folders")}><Icon name="folder" /></button> : null}</div>
          <nav className="folders" aria-label="Mail folders">
            {foldersQuery.isLoading ? Array.from({ length: 5 }, (_, index) => <div className="folder-skeleton skeleton" key={index} />) : null}
            {foldersQuery.isError ? <ErrorState message={foldersQuery.error.message} retry={() => void foldersQuery.refetch()} /> : null}
            {foldersQuery.data?.map((folder) => (
              <button key={folder.path} className={`folder-row ${folder.path === mailbox ? "active" : ""}`} onClick={() => selectFolder(folder.path)}>
                <Icon name={folderIcon(folder)} /><span>{folder.name}</span>{folder.unread > 0 ? <b>{folder.unread}</b> : null}
              </button>
            ))}
            {currentAccount ? <button className={`folder-row ${panel === "drafts" ? "active" : ""}`} onClick={() => setPanel("drafts")}><Icon name="mail" /><span>Local drafts</span>{accountDrafts.length > 0 ? <b>{accountDrafts.length}</b> : null}</button> : null}
          </nav>
          <div className="sidebar-note"><Icon name="sparkles" /><p><strong>Same mailbox, same capabilities</strong><br />WebMCP mirrors completed user workflows. Mailbox changes stay visible and undoable in Activity.</p></div>
        </aside>
        {mobileNav ? <button className="backdrop nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} /> : null}

        {!accountsQuery.isLoading && !accountsQuery.isError && !hasAccounts ? <section className="account-onboarding">
          <span className="onboarding-icon"><Icon name="mail" /></span>
          <h1>Connect your email</h1>
          <p>Add the IMAP and SMTP settings from your email provider. Postreeve tests both connections before saving anything.</p>
          <button className="primary-button" onClick={() => setAccountSetup("new")}><Icon name="plus" /> Connect account</button>
        </section> : <>
        <section className="message-column">
          <div className="mailbox-heading">
            <div><p>{currentAccount?.email ?? "Mailbox"}</p><h1>{currentFolder?.name ?? "Messages"}</h1></div>
            {currentFolder ? <div className="mailbox-heading-actions"><span className={currentFolder.unread ? "mailbox-unread-count" : ""}>{currentFolder.unread ? `${currentFolder.unread} unread` : "All read"}</span><span>{currentFolder.total.toLocaleString()} total</span><button className="icon-button" aria-label="Refresh mailbox" disabled={messagesQuery.isFetching || foldersQuery.isFetching} onClick={() => void refreshMailbox()}><Icon name="refresh" /></button></div> : null}
          </div>
          <form className="search-box" role="search" onSubmit={search}>
            <Icon name="search" />
            <input aria-label="Search messages" placeholder="Search this folder" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} />
            {queryDraft ? <button type="button" aria-label="Clear search" onClick={() => { setQueryDraft(""); setQuery(""); }}><Icon name="x" /></button> : null}
          </form>
          {query ? <div className="search-context">Results for “{query}” <button onClick={() => { setQuery(""); setQueryDraft(""); }}>Clear</button></div> : null}
          <div className="mailbox-controls">
            <label className="select-all"><input type="checkbox" aria-label="Select all visible messages" checked={visibleMessages.length > 0 && visibleMessages.every((message) => selectedMessages.has(messageKey(message)))} onChange={(event) => setSelectedMessages(event.target.checked ? new Set(visibleMessages.map(messageKey)) : new Set())} /><span>{selectedMessages.size ? `${selectedMessages.size} selected` : "Select"}</span></label>
            <select aria-label="Filter messages" value={messageFilter} onChange={(event) => setMessageFilter(event.target.value as MessageFilter)}><option value="all">All mail</option><option value="unread">Unread</option><option value="flagged">Flagged</option></select>
            <select aria-label="Sort messages" value={messageSort} onChange={(event) => setMessageSort(event.target.value as MessageSort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="sender">Sender</option><option value="subject">Subject</option></select>
          </div>
          {selectedMessages.size ? <BulkActionBar folders={foldersQuery.data ?? []} busy={bulkActionMutation.isPending} error={bulkActionMutation.error?.message ?? null} onAction={(action) => bulkActionMutation.mutate(action)} onCancel={() => setSelectedMessages(new Set())} /> : null}
          <div className="message-list" aria-label="Messages">
            {messagesQuery.isLoading ? Array.from({ length: 6 }, (_, index) => <div className="message-skeleton" key={index}><span className="skeleton" /><div><i className="skeleton" /><i className="skeleton short" /><i className="skeleton" /></div></div>) : null}
            {messagesQuery.isError ? <ErrorState message={messagesQuery.error.message} retry={() => void messagesQuery.refetch()} /> : null}
            {!messagesQuery.isLoading && !messagesQuery.isError && visibleMessages.length === 0 ? <EmptyState icon="inbox" title={query ? "No matching mail" : messageFilter === "all" ? "This folder is clear" : `No ${messageFilter} mail`} body={query ? "Try a broader search." : messageFilter === "all" ? "New messages will appear here." : "Change the filter to see other messages."} /> : null}
            {visibleMessages.map((message) => (
              <div className={`message-row-wrap ${selectedUid === message.ref.uid ? "selected" : ""} ${message.read ? "read" : "unread"}`} key={`${message.ref.uidValidity}:${message.ref.uid}`}>
                <label className="message-select"><input type="checkbox" aria-label={`Select ${message.subject || "message"}`} checked={selectedMessages.has(messageKey(message))} onChange={() => toggleMessageSelection(message)} /></label>
                <button className="message-row" onClick={() => setSelectedUid(message.ref.uid)}>
                  <span className={`sender-avatar tone-${message.ref.uid % 5}`}>{initials(sender(message))}</span>
                  <span className="message-copy">
                    <span className="message-meta"><strong>{sender(message)}</strong><time>{formatDate(message.receivedAt)}</time></span>
                    <span className="message-subject">{message.subject || "(No subject)"}</span>
                    <span className="message-preview">{message.preview}</span>
                  </span>
                  {!message.read ? <span className="unread-dot" aria-label="Unread" /> : null}
                </button>
              </div>
            ))}
            {messagesQuery.data && messagesQuery.data.length >= messageLimit && messageLimit < 100 ? <button className="load-more" disabled={messagesQuery.isFetching} onClick={() => setMessageLimit((current) => Math.min(100, current + 50))}>{messagesQuery.isFetching ? "Loading…" : "Load 50 more"}</button> : null}
          </div>
        </section>

        <main className="reader">
          {mailNotice ? <div className="mail-toast" role="status">{mailNotice}<button aria-label="Dismiss message" onClick={() => setMailNotice(null)}><Icon name="x" /></button></div> : null}
          {!selectedMessage ? <EmptyState icon="mail" title="No message selected" body="Choose an email from the list to read it here." /> : messageQuery.isLoading ? <ReaderSkeleton /> : messageQuery.isError ? <ErrorState message={messageQuery.error.message} retry={() => void messageQuery.refetch()} /> : messageQuery.data ? <MessageReader
            message={messageQuery.data}
            folders={foldersQuery.data ?? []}
            busy={directActionMutation.isPending}
            error={directActionMutation.error?.message ?? null}
            onCompose={(mode) => {
              const detail = messageQuery.data;
              if (detail) setComposeIntent({ mode, message: detail });
            }}
            onAction={(action) => {
              const detail = messageQuery.data;
              if (!detail) return;
              setMailNotice(null);
              directActionMutation.mutate({ message: detail, subject: detail.subject, action });
            }}
            onClose={() => setSelectedUid(null)}
          /> : <EmptyState icon="mail" title="Message unavailable" body="It may have moved since this folder was loaded." />}
        </main>
        </>}
      </div>

      {panel ? <button className="backdrop panel-backdrop" aria-label="Close panel" onClick={() => setPanel(null)} /> : null}
      <aside className={`workflow-panel ${panel ? "open" : ""}`} aria-hidden={!panel}>
        {panel === "history" ? <HistoryPanel
          batches={batchesQuery.data ?? []}
          loading={batchesQuery.isLoading}
          error={batchesQuery.error?.message ?? null}
          onClose={() => setPanel(null)}
          onRetry={() => void batchesQuery.refetch()}
          onRefresh={refreshWorkflow}
        /> : null}
        {panel === "drafts" && currentAccount ? <DraftPanel
          drafts={accountDrafts}
          onClose={() => setPanel(null)}
          onCreate={() => { setPanel(null); setComposeIntent({ mode: "new" }); }}
          onOpen={(draft) => { setPanel(null); setComposeIntent({ mode: "draft", draft }); }}
          onRemove={removeDraft}
        /> : null}
        {panel === "folders" && currentAccount ? <FolderPanel
          account={currentAccount}
          folders={foldersQuery.data ?? []}
          onChange={(folders, previousPath, nextPath) => {
            queryClient.setQueryData(["folders", currentAccount.id], folders);
            if (previousPath && mailbox === previousPath) setMailbox(nextPath ?? "");
            setSelectedUid(null);
            setSelectedMessages(new Set());
            void queryClient.invalidateQueries({ queryKey: ["messages", currentAccount.id] });
          }}
          onClose={() => setPanel(null)}
        /> : null}
        {panel === "identities" && currentAccount ? <IdentityPanel
          account={currentAccount}
          identities={accountIdentities}
          onChange={(next) => setIdentities((current) => [...current.filter((identity) => identity.accountId !== currentAccount.id), ...next])}
          onClose={() => setPanel(null)}
        /> : null}
      </aside>
      {accountSetup ? <AccountSetup
        account={accountSetup === "new" ? null : accountsQuery.data?.find(({ id }) => id === accountSetup) ?? null}
        onClose={() => setAccountSetup(null)}
        onSaved={(account) => { setAccountSetup(null); switchAccount(account.id); }}
        onRemoved={(removedId) => {
          setAccountSetup(null);
          if (accountId === removedId) switchAccount("");
        }}
      /> : null}
      {composeIntent && currentAccount ? <ComposeModal
        account={currentAccount}
        identities={accountIdentities}
        intent={composeIntent}
        onClose={() => setComposeIntent(null)}
        onSaveDraft={saveDraft}
        onSent={(draftId) => { if (draftId) removeDraft(draftId); }}
      /> : null}
    </div>
  );
}

function ReaderSkeleton() {
  return <div className="reader-skeleton"><i className="skeleton title" /><i className="skeleton line" /><i className="skeleton line short" /><hr /><i className="skeleton line" /><i className="skeleton line" /><i className="skeleton line short" /></div>;
}

function MessageReader({ message, folders, busy, error, onCompose, onAction, onClose }: {
  message: MessageDetail;
  folders: Folder[];
  busy: boolean;
  error: string | null;
  onCompose: (mode: "reply" | "reply_all" | "forward") => void;
  onAction: (action: TriageAction) => void;
  onClose: () => void;
}) {
  const safe = useMemo(() => message.html ? sanitizeEmailHtml(message.html) : null, [message.html]);
  const deliveredTo = additionalDeliveryAddresses(message);
  const [destination, setDestination] = useState("");
  const moveFolders = folders.filter((folder) => folder.path !== message.ref.mailbox && folder.specialUse !== "trash");
  const archiveFolder = folders.find((folder) => folder.specialUse === "archive" && folder.path !== message.ref.mailbox);
  const messageIsInTrash = folders.some((folder) => folder.path === message.ref.mailbox && folder.specialUse === "trash");
  useEffect(() => {
    if (!moveFolders.some((folder) => folder.path === destination)) setDestination(moveFolders[0]?.path ?? "");
  }, [destination, message.ref.mailbox, folders]);
  return <article className="message-reader">
    <button className="mobile-reader-back" onClick={onClose}><Icon name="chevron" /> Back to messages</button>
    <div className="reader-toolbar">
      <div className="conversation-actions"><button className="secondary-button" onClick={() => onCompose("reply")}><Icon name="reply" /> Reply</button><button className="secondary-button" onClick={() => onCompose("reply_all")}><Icon name="reply" /> Reply all</button><button className="secondary-button" onClick={() => onCompose("forward")}><Icon name="forward" /> Forward</button></div>
      <div className="reader-quick-actions" aria-label="Message actions">
        <button className="secondary-button" disabled={busy} onClick={() => onAction({ type: message.read ? "mark_unread" : "mark_read" })}>{message.read ? "Mark unread" : "Mark read"}</button>
        <button className="secondary-button" disabled={busy || !archiveFolder} onClick={() => archiveFolder && onAction({ type: "move", destination: archiveFolder.path })}><Icon name="archive" /> Archive</button>
        <button className="danger-button" disabled={busy || messageIsInTrash || folders.every((folder) => folder.specialUse !== "trash")} onClick={() => onAction({ type: "trash" })}><Icon name="trash" /> {messageIsInTrash ? "Already in Trash" : "Delete"}</button>
      </div>
    </div>
    <div className="reader-head">
      <div className="reader-labels">{message.read ? <span className="soft-pill">Read</span> : <span className="soft-pill unread">Unread</span>}{message.flagged ? <span className="soft-pill flagged">Flagged</span> : null}</div>
      <h2>{message.subject || "(No subject)"}</h2>
      <div className="reader-sender">
        <span className={`sender-avatar large tone-${message.ref.uid % 5}`}>{initials(sender(message))}</span>
        <div><strong>{sender(message)}</strong><span>to {addresses(message)}</span>{message.cc?.length ? <span>cc {message.cc.map((address) => address.name || address.address).join(", ")}</span> : null}{deliveredTo.length ? <span className="delivered-to">delivered to {deliveredTo.join(", ")}</span> : null}</div>
        <time>{formatDate(message.receivedAt, true)}</time>
      </div>
      <div className="reader-organize">
        <div className="move-control"><select aria-label="Move destination" disabled={busy || moveFolders.length === 0} value={destination} onChange={(event) => setDestination(event.target.value)}>{moveFolders.map((folder) => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select><button className="secondary-button" disabled={busy || !destination} onClick={() => onAction({ type: "move", destination })}>Move</button></div>
        <button className="secondary-button backend-pending" disabled title="Flag changes need mail-provider support"><Icon name="star" /> {message.flagged ? "Unflag" : "Flag"}</button>
      </div>
      {error ? <div className="inline-alert error reader-action-error">{error}</div> : null}
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

function BulkActionBar({ folders, busy, error, onAction, onCancel }: {
  folders: Folder[];
  busy: boolean;
  error: string | null;
  onAction: (action: TriageAction) => void;
  onCancel: () => void;
}) {
  const destinations = folders.filter((folder) => folder.specialUse !== "trash");
  const [destination, setDestination] = useState(destinations[0]?.path ?? "");
  useEffect(() => {
    if (!destinations.some((folder) => folder.path === destination)) setDestination(destinations[0]?.path ?? "");
  }, [destination, folders]);
  return <div className="bulk-actions" role="toolbar" aria-label="Selected message actions">
    <button disabled={busy} onClick={() => onAction({ type: "mark_read" })}>Mark read</button>
    <button disabled={busy} onClick={() => onAction({ type: "mark_unread" })}>Mark unread</button>
    <select aria-label="Bulk move destination" disabled={busy || !destination} value={destination} onChange={(event) => setDestination(event.target.value)}>{destinations.map((folder) => <option value={folder.path} key={folder.path}>{folder.name}</option>)}</select>
    <button disabled={busy || !destination} onClick={() => onAction({ type: "move", destination })}>Move</button>
    <button className="danger-text" disabled={busy || folders.every((folder) => folder.specialUse !== "trash")} onClick={() => onAction({ type: "trash" })}>Trash</button>
    <button aria-label="Cancel selection" disabled={busy} onClick={onCancel}><Icon name="x" /></button>
    {error ? <span className="bulk-error">{error}</span> : null}
  </div>;
}

function DraftPanel({ drafts, onClose, onCreate, onOpen, onRemove }: {
  drafts: LocalDraft[];
  onClose: () => void;
  onCreate: () => void;
  onOpen: (draft: LocalDraft) => void;
  onRemove: (id: string) => void;
}) {
  return <>
    <div className="panel-head"><div><span className="eyebrow"><Icon name="mail" /> Local workflow</span><h2>Drafts</h2></div><button className="icon-button" aria-label="Close drafts panel" onClick={onClose}><Icon name="x" /></button></div>
    <div className="panel-scroll draft-scroll">
      <div className="capability-note"><strong>Autosaved on this laptop</strong><p>These drafts prove the complete compose UI. IMAP Drafts synchronization will replace this local store in the backend pass.</p></div>
      {drafts.length ? <div className="draft-list">{drafts.map((draft) => <article key={draft.id}><button className="draft-open" onClick={() => onOpen(draft)}><strong>{draft.subject || "(No subject)"}</strong><span>{draft.to || "No recipient"}</span><small>{formatDate(draft.updatedAt, true)} · {draft.mode.replace("_", " ")}</small></button><button className="icon-button" aria-label={`Delete draft ${draft.subject || "without subject"}`} onClick={() => onRemove(draft.id)}><Icon name="trash" /></button></article>)}</div> : <EmptyState icon="mail" title="No local drafts" body="Start composing and Postreeve will autosave your work here." />}
    </div>
    <div className="panel-actions"><button className="primary-button wide" onClick={onCreate}><Icon name="plus" /> New message</button></div>
  </>;
}

function FolderPanel({ account, folders, onChange, onClose }: {
  account: Account;
  folders: Folder[];
  onChange: (folders: Folder[], previousPath?: string, nextPath?: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createFolder(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.createFolder({ accountId: account.id, name }));
      setNewName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Folder creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function renameFolder(event: FormEvent, path: string): Promise<void> {
    event.preventDefault();
    const name = renameName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.renameFolder({ accountId: account.id, path, name });
      const renamed = next.find((folder) => folder.name === name);
      onChange(next, path, renamed?.path);
      setEditingPath(null);
      setRenameName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Folder rename failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteFolder(path: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.deleteFolder({ accountId: account.id, path }), path);
      setDeletingPath(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Folder deletion failed");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="panel-head"><div><span className="eyebrow"><Icon name="folder" /> Mailbox structure</span><h2>Manage folders</h2></div><button className="icon-button" aria-label="Close folder panel" onClick={onClose}><Icon name="x" /></button></div>
    <div className="panel-scroll">
      <div className="capability-note"><strong>Changes apply to {account.kind === "gmail" ? "Gmail" : "the IMAP server"}</strong><p>{account.kind === "gmail" ? "Deleting a custom label removes the label but keeps its messages in Gmail." : "IMAP folders must be empty before they can be deleted. System and special-use folders stay protected."}</p></div>
      {error ? <div className="inline-alert error">{error}</div> : null}
      <div className="folder-management-list">{folders.map((folder) => {
        const custom = folder.specialUse === null;
        const canDelete = custom && (account.kind === "gmail" || folder.total === 0);
        return <article key={folder.path} aria-label={folder.name} className={editingPath === folder.path || deletingPath === folder.path ? "editing" : ""}>
          <div className="folder-management-summary"><Icon name={folderIcon(folder)} /><span><strong>{folder.name}</strong><small>{folder.total.toLocaleString()} messages · {custom ? "custom" : folder.specialUse}</small></span>{custom ? <div className="folder-row-actions"><button disabled={busy} onClick={() => { setEditingPath(folder.path); setRenameName(folder.name); setDeletingPath(null); setError(null); }}>Rename</button><button className="folder-delete-button" disabled={busy || !canDelete} title={!canDelete ? "Move every message out before deleting this IMAP folder" : undefined} onClick={() => { setDeletingPath(folder.path); setEditingPath(null); setError(null); }}>Delete</button></div> : <span className="folder-kind">Protected</span>}</div>
          {editingPath === folder.path ? <form className="folder-inline-form" onSubmit={(event) => void renameFolder(event, folder.path)}><label className="field"><span>New folder name</span><input autoFocus aria-label={`Rename ${folder.name}`} value={renameName} onChange={(event) => setRenameName(event.target.value)} /></label><div><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditingPath(null)}>Cancel</button><button className="primary-button" disabled={busy || !renameName.trim() || renameName.trim() === folder.name}>{busy ? "Renaming…" : "Save name"}</button></div></form> : null}
          {deletingPath === folder.path ? <div className="folder-delete-confirm"><strong>Delete “{folder.name}”?</strong><p>{account.kind === "gmail" ? "Messages keep their other Gmail labels and remain in All Mail." : "Only an empty IMAP folder can be deleted."}</p><div><button className="secondary-button" disabled={busy} onClick={() => setDeletingPath(null)}>Cancel</button><button className="danger-button" disabled={busy} onClick={() => void deleteFolder(folder.path)}>{busy ? "Deleting…" : `Delete ${folder.name}`}</button></div></div> : null}
        </article>;
      })}</div>
      <form className="folder-create-form" onSubmit={(event) => void createFolder(event)}><label className="field"><span>New custom folder</span><input aria-label="New folder name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Receipts, Projects, Keep…" /></label><button className="primary-button" disabled={busy || !newName.trim()}>{busy ? "Creating…" : "Create folder"}</button></form>
    </div>
  </>;
}

function IdentityPanel({ account, identities, onChange, onClose }: {
  account: Account;
  identities: LocalIdentity[];
  onChange: (identities: LocalIdentity[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return <>
    <div className="panel-head"><div><span className="eyebrow"><Icon name="mail" /> Sending addresses</span><h2>Identities</h2></div><button className="icon-button" aria-label="Close identities panel" onClick={onClose}><Icon name="x" /></button></div>
    <div className="panel-scroll">
      <div className="capability-note"><strong>Catch-all UI is ready</strong><p>Aliases are stored locally and appear in the From selector. Sending from them stays blocked until SMTP identity validation is implemented.</p></div>
      <div className="identity-list"><div><span className="avatar">{initials(account.name)}</span><span><strong>{account.name}</strong><small>{account.email} · primary</small></span></div>{identities.map((identity) => <div key={identity.id}><span className="avatar">{initials(identity.name)}</span><span><strong>{identity.name}</strong><small>{identity.email}</small></span><button className="icon-button" aria-label={`Remove identity ${identity.email}`} onClick={() => onChange(identities.filter(({ id }) => id !== identity.id))}><Icon name="x" /></button></div>)}</div>
      <form className="identity-form" onSubmit={(event) => { event.preventDefault(); if (!valid || !name.trim()) return; onChange([...identities, { id: crypto.randomUUID(), accountId: account.id, name: name.trim(), email: email.trim().toLowerCase() }]); setName(""); setEmail(""); }}><label className="field"><span>Display name</span><input aria-label="Identity name" value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>Email address</span><input aria-label="Identity email address" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><button className="secondary-button" disabled={!valid || !name.trim()}><Icon name="plus" /> Add identity</button></form>
    </div>
  </>;
}

function ComposeModal({ account, identities, intent, onClose, onSaveDraft, onSent }: {
  account: { id: string; name: string; email: string };
  identities: LocalIdentity[];
  intent: ComposeIntent;
  onClose: () => void;
  onSaveDraft: (draft: LocalDraft) => void;
  onSent: (draftId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const source = intent.message;
  const saved = intent.draft;
  const effectiveMode = saved?.mode ?? intent.mode;
  const replyAllCc = source
    ? [...source.to, ...(source.cc ?? [])]
      .map(({ address }) => address)
      .filter((address, index, all) => address.toLowerCase() !== account.email.toLowerCase() && all.indexOf(address) === index)
      .join(", ")
    : "";
  const initialBody = source
    ? effectiveMode === "forward"
      ? `\n\n---------- Forwarded message ----------\nFrom: ${addressList(source.from)}\nDate: ${formatDate(source.receivedAt, true)}\nSubject: ${source.subject}\nTo: ${addressList(source.to)}\n\n${source.text}`
      : quotedMessage(source)
    : "";
  const [draftId] = useState(() => saved?.id ?? crypto.randomUUID());
  const [from, setFrom] = useState(saved?.from ?? account.email);
  const [to, setTo] = useState(saved?.to ?? (source && effectiveMode !== "forward" ? addressList(source.from) : ""));
  const [cc, setCc] = useState(saved?.cc ?? (effectiveMode === "reply_all" ? replyAllCc : ""));
  const [bcc, setBcc] = useState(saved?.bcc ?? "");
  const [subject, setSubject] = useState(saved?.subject ?? (source ? effectiveMode === "forward" ? forwardSubject(source.subject) : replySubject(source.subject) : ""));
  const [body, setBody] = useState(saved?.body ?? initialBody);
  const [attachments, setAttachments] = useState<LocalAttachment[]>(saved ? [...saved.attachments] : []);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SendReceipt | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(saved?.updatedAt ?? null);
  const backendPending = effectiveMode === "reply" || effectiveMode === "reply_all" || effectiveMode === "forward" || from !== account.email || attachments.length > 0;

  function currentDraft(): LocalDraft {
    return {
      id: draftId,
      accountId: account.id,
      mode: effectiveMode === "draft" ? "new" : effectiveMode,
      from,
      to,
      cc,
      bcc,
      subject,
      body,
      attachments,
      updatedAt: new Date().toISOString(),
    };
  }

  useEffect(() => {
    if (![to, cc, bcc, subject, body].some((value) => value.trim()) && attachments.length === 0) return;
    const timeout = window.setTimeout(() => {
      const draft = currentDraft();
      onSaveDraft(draft);
      setSavedAt(draft.updatedAt);
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [attachments, bcc, body, cc, from, subject, to]);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof api.sendMessage>[0]) => api.sendMessage(input),
    onSuccess: async (nextReceipt) => {
      setReceipt(nextReceipt);
      onSent(draftId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", account.id] }),
        queryClient.invalidateQueries({ queryKey: ["folders", account.id] }),
      ]);
    },
  });

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
    mutation.mutate({ accountId: account.id, to: toAddresses, cc: ccAddresses, bcc: bccAddresses, subject, text: body });
  }

  const modeLabel = effectiveMode === "reply_all" ? "Reply all" : effectiveMode === "reply" ? "Reply" : effectiveMode === "forward" ? "Forward" : saved ? "Edit draft" : "New message";
  return <div className="modal-layer compose-layer">
    <button className="backdrop" aria-label="Close compose" disabled={mutation.isPending} onClick={onClose} />
    <form className="account-modal compose-modal" onSubmit={submit}>
      <div className="panel-head"><div><span className="eyebrow"><Icon name={effectiveMode === "forward" ? "forward" : effectiveMode === "reply" || effectiveMode === "reply_all" ? "reply" : "send"} /> {modeLabel}</span><h2>{receipt ? "Message sent" : subject || "Compose email"}</h2></div>{!mutation.isPending ? <button type="button" className="icon-button" aria-label="Close compose" onClick={onClose}><Icon name="x" /></button> : null}</div>
      {receipt ? <div className="compose-success"><span><Icon name="send" /></span><h3>Message sent</h3><p>Accepted for delivery to {receipt.accepted.length} recipient{receipt.accepted.length === 1 ? "" : "s"}.</p>{receipt.rejected.length ? <div className="inline-alert error">Rejected: {receipt.rejected.join(", ")}</div> : null}</div> : <div className="setup-body compose-body">
        <label className="from-field"><span>From</span><strong>{account.name}</strong><select aria-label="From identity" value={from} onChange={(event) => setFrom(event.target.value)}><option value={account.email}>{account.email}</option>{identities.map((identity) => <option value={identity.email} key={identity.id}>{identity.name} · {identity.email}</option>)}</select></label>
        <label className="field"><span>To</span><input autoFocus required type="text" inputMode="email" aria-label="To" placeholder="person@example.com, team@example.com" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <div className="field-grid"><label className="field"><span>Cc <i>optional</i></span><input type="text" inputMode="email" aria-label="Cc" value={cc} onChange={(event) => setCc(event.target.value)} /></label><label className="field"><span>Bcc <i>optional</i></span><input type="text" inputMode="email" aria-label="Bcc" value={bcc} onChange={(event) => setBcc(event.target.value)} /></label></div>
        <label className="field"><span>Subject</span><input maxLength={998} aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <label className="field"><span>Message</span><textarea required rows={12} maxLength={2_000_000} aria-label="Message" value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <div className="attachment-field"><label className="secondary-button"><Icon name="paperclip" /> Add attachments<input type="file" multiple onChange={(event) => setAttachments((current) => [...current, ...[...(event.target.files ?? [])].map((file) => ({ name: file.name, size: file.size, type: file.type }))])} /></label><span>Files stay local in this UI pass.</span></div>
        {attachments.length ? <div className="attachment-list">{attachments.map((attachment, index) => <div key={`${attachment.name}:${index}`}><Icon name="paperclip" /><span><strong>{attachment.name}</strong><small>{Math.max(1, Math.round(attachment.size / 1024))} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, candidate) => candidate !== index))}><Icon name="x" /></button></div>)}</div> : null}
        {backendPending ? <div className="inline-alert pending"><strong>Frontend ready, backend pending.</strong> Thread headers, alternate From identities, and attachment delivery are intentionally blocked until the mail layer supports them.</div> : null}
        {validationError ? <div className="inline-alert error">{validationError}</div> : null}
        {mutation.isError ? <div className="inline-alert error">{mutation.error.message}</div> : null}
      </div>}
      <div className="modal-actions compose-actions">{receipt ? <button type="button" className="primary-button" onClick={onClose}>Done</button> : <><span className="draft-status">{savedAt ? `Draft saved locally ${formatDate(savedAt, true)}` : "Drafts autosave locally"}</span><button type="button" className="secondary-button" onClick={() => { const draft = currentDraft(); onSaveDraft(draft); setSavedAt(draft.updatedAt); }}>Save draft</button><button type="button" className="secondary-button" disabled={mutation.isPending} onClick={onClose}>Close</button><button className="primary-button" disabled={mutation.isPending || !body.trim() || backendPending} title={backendPending ? "Backend support is required before this message can be sent" : undefined}><Icon name="send" />{mutation.isPending ? "Sending…" : "Send message"}</button></>}</div>
    </form>
  </div>;
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
      {props.loading ? <ReaderSkeleton /> : props.error ? <ErrorState message={props.error} retry={props.onRetry} /> : props.batches.length === 0 ? <EmptyState icon="history" title="No activity yet" body="Mailbox actions and their individual results will appear here." /> : props.batches.map((batch) => <section className="batch-card" key={batch.id}>
        <div className="batch-head"><div><StatusPill status={batch.status} /><time>{formatDate(batch.updatedAt, true)}</time></div><span>{batch.operations.length} operation{batch.operations.length === 1 ? "" : "s"}</span></div>
        <div className="operation-list">{batch.operations.map((operation) => <div className="operation" key={operation.itemId}><span className={`result-dot ${operation.status}`} /><div><strong>{actionLabels[operation.action.type]}</strong><span>UID {operation.message.uid} · {operation.message.mailbox}</span>{operation.error ? <em>{operation.error}</em> : null}</div><small>{operation.status.replaceAll("_", " ")}</small></div>)}</div>
        {(batch.status === "applied" || batch.status === "partially_applied") ? <button className="secondary-button wide" disabled={undoMutation.isPending} onClick={() => { setUndoError(null); undoMutation.mutate(batch.id); }}>{undoMutation.isPending && undoMutation.variables === batch.id ? "Undoing…" : "Undo supported actions"}</button> : null}
      </section>)}
      {undoError ? <div className="inline-alert error">{undoError}</div> : null}
    </div>
  </>;
}

function AccountSetup({ account, onClose, onSaved, onRemoved }: {
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
      name: name.trim(),
      email: email.trim(),
      host: host.trim(),
      port: Number(port),
      secure,
      username: username.trim(),
      ...(password ? { password } : {}),
      smtpHost: smtpHost.trim(),
      smtpPort: Number(smtpPort),
      smtpSecure,
      smtpUsername: smtpUsername.trim(),
      ...(smtpPassword ? { smtpPassword } : {}),
    };
  }

  function createInput(): CreateAccountInput {
    return { kind: "imap", ...updateInput(), password, smtpPassword };
  }

  function cacheAccount(account: Account): void {
    queryClient.setQueryData<Account[]>(["accounts"], (accounts = []) => {
      const exists = accounts.some(({ id }) => id === account.id);
      return exists ? accounts.map((current) => current.id === account.id ? account : current) : [...accounts, account];
    });
  }

  const saveMutation = useMutation({
    mutationFn: () => accountId ? api.updateAccount(accountId, updateInput()) : api.createAccount(createInput()),
    onSuccess: (account) => {
      cacheAccount(account);
      onSaved(account);
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
  function submit(event: FormEvent): void {
    event.preventDefault();
    saveMutation.mutate();
  }
  return <div className="modal-layer"><button className="backdrop" aria-label="Close account setup" onClick={onClose} /><form className="account-modal" onSubmit={submit}>
    <div className="panel-head"><div><span className="eyebrow">Account settings</span><h2>{accountId ? "Manage mailbox" : "Connect a mailbox"}</h2></div><button type="button" className="icon-button" aria-label="Close account setup" onClick={onClose}><Icon name="x" /></button></div>
    <div className="setup-body">
      <p className="setup-copy">Connect Google with OAuth, or connect another provider through IMAP and SMTP. Credentials stay encrypted on this server and are never returned to the browser.</p>
      {!accountId && googleStatusQuery.data?.configured ? <div className="google-connect"><strong>Gmail</strong><p>Authorize Postreeve through Google. Your Google password never enters Postreeve.</p><a className="primary-button" href="/api/oauth/google/start">Continue with Google</a></div> : null}
      {!accountId && googleStatusQuery.data?.configured ? <div className="setup-divider"><span>or use mail server settings</span></div> : null}
      {isGmail ? <>
        <div className="google-connect connected"><strong>Connected with Google</strong><p>{account.email}</p><a className="secondary-button" href="/api/oauth/google/start">Reauthorize Google account</a></div>
        <div className="remove-account-section"><strong>Remove account</strong><p>This permanently removes its encrypted Google token and local activity history. It does not delete mail from Gmail.</p>{confirmRemoval ? <div className="remove-confirmation"><span>This cannot be undone.</span><button type="button" className="danger-button" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate()}>{removeMutation.isPending ? "Removing…" : "Remove account and local history"}</button><button type="button" className="text-button" onClick={() => setConfirmRemoval(false)}>Cancel</button></div> : <button type="button" className="danger-button" onClick={() => setConfirmRemoval(true)}>Remove account…</button>}{removeMutation.isError ? <div className="inline-alert error">{removeMutation.error.message}</div> : null}</div>
      </> : null}
      {settingsQuery.isLoading ? <ReaderSkeleton /> : null}
      {settingsQuery.isError ? <ErrorState message={settingsQuery.error.message} retry={() => void settingsQuery.refetch()} /> : null}
      {!isGmail && (!accountId || settingsQuery.isSuccess) ? <>
      <div className="field-grid"><label className="field"><span>Name</span><input required value={name} placeholder="Work" onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>Email address</span><input required type="email" value={email} placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /></label></div>
      <fieldset className="connection-group"><legend>Incoming mail (IMAP)</legend>
          <div className="field-grid host-grid"><label className="field"><span>IMAP host</span><input required value={host} placeholder="imap.example.com" onChange={(event) => { const value = event.target.value; setHost(value); if (!smtpHostEdited) setSmtpHost(value.replace(/^imap\./i, "smtp.")); }} /></label><label className="field"><span>Port</span><input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label></div>
          <label className="check-field"><input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} /><span>Use a secure TLS connection</span></label>
          <div className="field-grid"><label className="field"><span>Username</span><input required autoComplete="username" value={username} onChange={(event) => { const value = event.target.value; setUsername(value); if (!smtpUsernameEdited) setSmtpUsername(value); }} /></label><label className="field"><span>Password {accountId ? <i>(leave blank to keep current)</i> : null}</span><input required={!accountId} type="password" autoComplete="current-password" value={password} onChange={(event) => { const value = event.target.value; setPassword(value); if (!smtpPasswordEdited) setSmtpPassword(value); }} /></label></div>
        </fieldset>
      <fieldset className="connection-group"><legend>Outgoing mail (SMTP)</legend>
          <p className="connection-hint">Prefilled from IMAP. Change any value if your provider uses different SMTP settings.</p>
          <div className="field-grid host-grid"><label className="field"><span>SMTP host</span><input required value={smtpHost} placeholder="smtp.example.com" onChange={(event) => { setSmtpHostEdited(true); setSmtpHost(event.target.value); }} /></label><label className="field"><span>Port</span><input required type="number" min="1" max="65535" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} /></label></div>
          <label className="check-field"><input type="checkbox" checked={smtpSecure} onChange={(event) => setSmtpSecure(event.target.checked)} /><span>Use a secure TLS connection</span></label>
          <div className="field-grid"><label className="field"><span>Username</span><input required autoComplete="username" value={smtpUsername} onChange={(event) => { setSmtpUsernameEdited(true); setSmtpUsername(event.target.value); }} /></label><label className="field"><span>Password {accountId ? <i>(leave blank to keep current)</i> : null}</span><input required={!accountId} type="password" autoComplete="current-password" value={smtpPassword} onChange={(event) => { setSmtpPasswordEdited(true); setSmtpPassword(event.target.value); }} /></label></div>
        </fieldset>
      {testMutation.isSuccess ? <div className="inline-alert success">IMAP and SMTP connections succeeded.</div> : null}
      {testMutation.isError ? <div className="inline-alert error">{testMutation.error.message}</div> : null}
      {saveMutation.isError ? <div className="inline-alert error">{saveMutation.error.message}</div> : null}
      {accountId ? <div className="remove-account-section"><strong>Remove account</strong><p>This permanently removes its encrypted credentials and local activity history. It does not delete mail from your provider.</p>{confirmRemoval ? <div className="remove-confirmation"><span>This cannot be undone.</span><button type="button" className="danger-button" disabled={removeMutation.isPending} onClick={() => removeMutation.mutate()}>{removeMutation.isPending ? "Removing…" : "Remove account and local history"}</button><button type="button" className="text-button" onClick={() => setConfirmRemoval(false)}>Cancel</button></div> : <button type="button" className="danger-button" onClick={() => setConfirmRemoval(true)}>Remove account…</button>}{removeMutation.isError ? <div className="inline-alert error">{removeMutation.error.message}</div> : null}</div> : null}
      </> : null}
    </div>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{isGmail ? "Done" : "Cancel"}</button>{!isGmail ? <><button type="button" className="secondary-button" disabled={!connectionFieldsComplete || testMutation.isPending || saveMutation.isPending || (Boolean(accountId) && !settingsQuery.isSuccess)} onClick={() => testMutation.mutate()}>{testMutation.isPending ? "Testing…" : "Test connection"}</button><button className="primary-button" disabled={!connectionFieldsComplete || saveMutation.isPending || testMutation.isPending || (Boolean(accountId) && !settingsQuery.isSuccess)}>{saveMutation.isPending ? "Connecting…" : accountId ? "Save and reconnect" : "Connect account"}</button></> : null}</div>
  </form></div>;
}

export default App;
