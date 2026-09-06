import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, Draft, Folder, MessageSummary, ReceivedAttachment, TriageAction } from "../shared/contracts";
import { api } from "./api";
import { registerPostreeveWebMcp } from "../server/webmcp/register";
import { subscribeToWebMcpFolderLists, subscribeToWebMcpMailboxViews, webMcpServices } from "./webmcp";
import { exposedToolNames, loadHiddenTools, storeHiddenTools } from "./assistant-tools";
import { ActivityView } from "./ActivityView";
import { MessageList } from "./MessageList";
import { Reader } from "./Reader";
import { Sidebar } from "./Sidebar";
import { SettingsView, settingsSections, type SettingsSection } from "./SettingsView";
import { AccountSetup, ComposeModal, DraftsSheet, FolderSheet, IdentitySheet, type ComposeIntent } from "./panels";
import {
  countLine,
  messageIdentityKeys,
  messageIsSelected,
  messageKey,
  messageMatchesKey,
  mergeMessages,
  filterMessages,
  scopeSources,
  sortMessages,
  specialUseName,
  type Scope,
} from "./mail-view";
import {
  buildProvenance,
  provenanceKey,
  recordUserBatch,
  type Actor,
} from "./provenance";
import {
  loadLocalIdentities,
  storeLocalIdentities,
  type LocalIdentity,
  type MessageFilter,
  type MessageSort,
} from "./mail-ui-state";
import { migrateLocalDraftsOnce } from "./draft-state";
import { useTheme } from "./theme";

const folderPollIntervalMs = 15_000;
/** Below this the sidebar covers the list, so choosing a folder closes it again. */
const narrowWidth = 900;
const tabs = [["Mailbox", "mail"], ["Activity", "activity"], ["Settings", "settings"]] as const;
type View = (typeof tabs)[number][1];

type Overlay =
  | { kind: "compose"; accountId: string; intent: ComposeIntent }
  | { kind: "account"; accountId: string | "new" }
  | { kind: "folders"; accountId: string }
  | { kind: "identities"; accountId: string }
  | { kind: "drafts" }
  | null;

interface UndoEntry {
  readonly label: string;
  readonly batchIds: readonly string[];
}

/** Lucide's panel-left, squared off for the system. The column fills when the sidebar is showing. */
function PanelIcon({ filled }: { filled: boolean }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" />
    <path d="M9 4v16" />
    {filled ? <rect x="3" y="4" width="6" height="16" fill="currentColor" stroke="none" /> : null}
  </svg>;
}

function App() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const searchRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useState<View>("mail");
  const [section, setSection] = useState<SettingsSection>("Accounts");
  const [scope, setScope] = useState<Scope | null>(null);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > narrowWidth);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MessageFilter>("all");
  const [sort, setSort] = useState<MessageSort>("newest");
  const [limit, setLimit] = useState(50);
  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<readonly UndoEntry[]>([]);
  const [actorFilter, setActorFilter] = useState<Actor | "all">("all");
  const [hiddenTools, setHiddenTools] = useState<ReadonlySet<string>>(loadHiddenTools);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [identities, setIdentities] = useState<LocalIdentity[]>(loadLocalIdentities);

  useEffect(() => storeLocalIdentities(identities), [identities]);
  useEffect(() => storeHiddenTools(hiddenTools), [hiddenTools]);

  const toastTimer = useRef<number>(0);
  function flash(text: string): void {
    window.clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }

  // ── Data ────────────────────────────────────────────────────────────
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: ({ signal }) => api.accounts(signal) });
  const accounts: readonly Account[] = accountsQuery.data ?? [];
  const googleStatusQuery = useQuery({ queryKey: ["google-oauth-status"], queryFn: ({ signal }) => api.googleOAuthStatus(signal) });

  const folderResults = useQueries({
    queries: accounts.map((account) => ({
      queryKey: ["folders", account.id],
      queryFn: () => api.folders(account.id),
      refetchInterval: folderPollIntervalMs,
    })),
  });
  const foldersByAccount = new Map<string, readonly Folder[]>(
    accounts.map((account, index) => [account.id, folderResults[index]?.data ?? []]),
  );
  const draftResults = useQueries({
    queries: accounts.map((account) => ({ queryKey: ["drafts", account.id], queryFn: () => api.drafts(account.id) })),
  });
  const drafts: readonly Draft[] = draftResults.flatMap((result) => result.data ?? []);
  const draftsLoaded = draftResults.length === accounts.length && draftResults.every(({ data }) => data !== undefined);
  const draftsLoading = draftResults.some(({ isPending }) => isPending);
  const draftsRefreshing = draftResults.some(({ data, isFetching }) => data !== undefined && isFetching);
  const draftLoadFailure = draftResults.find(({ error }) => error !== null)?.error;
  const draftLoadError = draftLoadFailure instanceof Error
    ? draftLoadFailure.message
    : draftLoadFailure
      ? "Draft loading failed"
      : null;
  const migrationAccountSnapshot = accounts.map(({ id }) => id).sort().join("\0");
  const migratedAccountSnapshot = useRef<string | null>(null);
  useEffect(() => {
    if (!accountsQuery.isSuccess || migratedAccountSnapshot.current === migrationAccountSnapshot) return;
    migratedAccountSnapshot.current = migrationAccountSnapshot;
    void migrateLocalDraftsOnce(localStorage, accounts, api.createDraft).then(async ({ migrated }) => {
      if (migrated > 0) await queryClient.invalidateQueries({ queryKey: ["drafts"] });
    }).catch((error: unknown) => {
      migratedAccountSnapshot.current = null;
      flash(error instanceof Error ? error.message : "Local draft migration failed");
    });
  }, [accountsQuery.isSuccess, migrationAccountSnapshot, queryClient]);

  const batchResults = useQueries({
    queries: accounts.map((account) => ({ queryKey: ["batches", account.id], queryFn: () => api.batches(account.id) })),
  });
  const batches = batchResults.flatMap((result) => result.data ?? []);
  const proposalResults = useQueries({
    queries: accounts.map((account) => ({ queryKey: ["proposals", account.id], queryFn: () => api.proposals(account.id) })),
  });
  const proposals = proposalResults.flatMap((result) => result.data ?? []);
  const provenance = useMemo(() => buildProvenance(batches, proposals), [batches, proposals]);
  const awaitingByAccount = new Map<string, number>(accounts.map((account, index) => [
    account.id,
    (proposalResults[index]?.data ?? [])
      .filter((proposal) => proposal.status === "draft" || proposal.status === "review" || proposal.status === "approved")
      .reduce((total, proposal) => total + proposal.items.length, 0),
  ]));

  // The first account list decides whether the unified view is even meaningful.
  useEffect(() => {
    if (scope !== null || accounts.length === 0) return;
    if (accounts.length > 1) {
      setScope({ kind: "unified", specialUse: "inbox" });
      return;
    }
    const only = accounts[0];
    if (!only) return;
    const folders = foldersByAccount.get(only.id) ?? [];
    const inbox = folders.find((folder) => folder.specialUse === "inbox") ?? folders[0];
    if (inbox) setScope({ kind: "account", accountId: only.id, path: inbox.path });
  }, [accounts, folderResults.map((result) => result.data?.length).join()]);

  const sources = scope ? scopeSources(scope, foldersByAccount) : [];
  const messageResults = useQueries({
    queries: sources.map((source) => ({
      queryKey: ["messages", source.accountId, source.mailbox, query, limit],
      queryFn: () => api.messages(source.accountId, source.mailbox, query, limit),
    })),
  });
  const messages = sortMessages(
    filterMessages(mergeMessages(messageResults.map((result) => result.data ?? [])), filter),
    sort,
  );
  const messagesLoading = messageResults.some((result) => result.isLoading);
  const messagesError = messageResults.find((result) => result.error)?.error?.message ?? null;
  const busy = messageResults.some((result) => result.isFetching);

  const openMessage = messages.find((message) => messageMatchesKey(message, openKey)) ?? null;
  const detailQuery = useQuery({
    queryKey: ["message", openKey, openMessage?.ref],
    queryFn: async () => (await api.readMessages(openMessage ? [openMessage.ref] : []))[0] ?? null,
    enabled: Boolean(openMessage),
  });

  const scopeAccountId = scope?.kind === "account" ? scope.accountId : null;
  const scopeFolders = scopeAccountId
    ? foldersByAccount.get(scopeAccountId) ?? []
    : (openMessage ? foldersByAccount.get(openMessage.ref.accountId) ?? [] : []);
  const folderName = scope === null ? ""
    : scope.kind === "unified" ? specialUseName(scope.specialUse)
    : (foldersByAccount.get(scope.accountId) ?? []).find((folder) => folder.path === scope.path)?.name ?? scope.path;
  const scopeTitle = scope === null ? "Mailbox"
    : scope.kind === "unified" ? `Unified · ${folderName}`
    : `${accounts.find((account) => account.id === scope.accountId)?.email ?? ""} · ${folderName}`;
  const composeAccountId = openMessage?.ref.accountId ?? scopeAccountId ?? accounts[0]?.id ?? "";

  // ── Operations ──────────────────────────────────────────────────────
  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["messages"] }),
      queryClient.invalidateQueries({ queryKey: ["message"] }),
      ...accounts.flatMap((account) => [
        queryClient.invalidateQueries({ queryKey: ["folders", account.id] }),
        queryClient.invalidateQueries({ queryKey: ["batches", account.id] }),
        queryClient.invalidateQueries({ queryKey: ["proposals", account.id] }),
      ]),
    ]);
  }

  async function downloadReceivedAttachment(accountId: string, attachment: ReceivedAttachment): Promise<void> {
    const content = await api.downloadAttachment(accountId, attachment);
    const url = URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const actionMutation = useMutation({
    mutationFn: async ({ targets, action }: { targets: readonly MessageSummary[]; action: TriageAction }) => {
      const byAccount = new Map<string, MessageSummary[]>();
      for (const message of targets) {
        const group = byAccount.get(message.ref.accountId) ?? [];
        group.push(message);
        byAccount.set(message.ref.accountId, group);
      }
      return Promise.all([...byAccount].map(([accountId, group]) => api.applyDirectActions({
        accountId,
        items: group.map((message) => ({ message: message.ref, subject: message.subject, action })),
      })));
    },
    onSuccess: async (created, { targets, action }) => {
      for (const batch of created) recordUserBatch(batch.id);
      const label = action.type === "move" ? `Moved ${targets.length} to ${action.destination}`
        : action.type === "trash" ? `Moved ${targets.length} to Trash`
        : action.type === "mark_read" ? `Marked ${targets.length} read`
        : `Marked ${targets.length} unread`;
      setUndoStack((current) => [{ label, batchIds: created.map(({ id }) => id) }, ...current].slice(0, 8));
      setSelected(new Set());
      if (action.type === "move" || action.type === "trash") setOpenKey(null);
      flash(label);
      await refresh();
    },
    onError: (error) => flash(error.message),
  });

  const acceptMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      await api.approveProposal(proposalId);
      return api.applyProposalBatch(proposalId);
    },
    onSuccess: async (batch) => {
      setUndoStack((current) => [{ label: "Accepted proposal", batchIds: [batch.id] }, ...current].slice(0, 8));
      flash("Accepted proposal");
      await refresh();
    },
    onError: (error) => flash(error.message),
  });

  const undoMutation = useMutation({
    mutationFn: (batchIds: readonly string[]) => Promise.all(batchIds.map((id) => api.undoBatch(id))),
    onSuccess: async (_batches, batchIds) => {
      setUndoStack((current) => current.filter((entry) => entry.batchIds !== batchIds));
      flash("Reverted");
      await refresh();
    },
    onError: (error) => flash(error.message),
  });

  function undoLast(): void {
    const entry = undoStack[0];
    if (!entry || undoMutation.isPending) return;
    undoMutation.mutate(entry.batchIds);
  }

  function targetsFor(fallback: MessageSummary | undefined): MessageSummary[] {
    const chosen = messages.filter((message) => messageIsSelected(message, selected));
    return chosen.length ? chosen : fallback ? [fallback] : [];
  }

  function applyTo(targets: readonly MessageSummary[], action: TriageAction): void {
    if (targets.length === 0) return;
    actionMutation.mutate({ targets, action });
  }

  function openRow(message: MessageSummary): void {
    setOpenKey(messageKey(message));
    setFocus(messages.findIndex((candidate) => messageMatchesKey(candidate, messageKey(message))));
    setSelected(new Set());
  }

  function step(direction: 1 | -1): void {
    const next = Math.max(0, Math.min(messages.length - 1, focus + direction));
    const message = messages[next];
    if (!message) return;
    setFocus(next);
    setSelected(openKey ? new Set() : new Set([messageKey(message)]));
    if (openKey) setOpenKey(messageKey(message));
  }

  function changeScope(next: Scope): void {
    setScope(next);
    if (window.innerWidth <= narrowWidth) setSideOpen(false);
    setView("mail");
    setOpenKey(null);
    setFocus(0);
    setSelected(new Set());
    setLimit(50);
  }

  // ── WebMCP ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribeViews = subscribeToWebMcpMailboxViews((incoming) => {
      queryClient.setQueryData(
        ["messages", incoming.accountId, incoming.mailbox, incoming.query, incoming.limit],
        [...incoming.messages],
      );
      setScope({ kind: "account", accountId: incoming.accountId, path: incoming.mailbox });
      setView("mail");
      setQueryDraft(incoming.query);
      setQuery(incoming.query);
      setFilter(incoming.filter);
      setSort(incoming.sort);
      setLimit(incoming.limit);
      setOpenKey(null);
      setFocus(0);
      setSelected(new Set());
      flash("WebMCP updated the visible mailbox view.");
    });
    const unsubscribeFolders = subscribeToWebMcpFolderLists((accountId, folders) => {
      queryClient.setQueryData(["folders", accountId], [...folders]);
      setScope((current) => {
        if (current?.kind === "account" && current.accountId === accountId && folders.some(({ path }) => path === current.path)) return current;
        const inbox = folders.find(({ specialUse }) => specialUse === "inbox") ?? folders[0];
        return inbox ? { kind: "account", accountId, path: inbox.path } : current;
      });
      setOpenKey(null);
      setSelected(new Set());
      flash("WebMCP updated the folder list.");
    });
    return () => {
      unsubscribeViews();
      unsubscribeFolders();
    };
  }, [queryClient]);

  const exposed = exposedToolNames(hiddenTools).join(",");
  useEffect(() => {
    let active = true;
    let dispose = (): void => undefined;
    void registerPostreeveWebMcp(webMcpServices, undefined, { exposedToolNames: exposed ? exposed.split(",") : [] })
      .then((registration) => {
        if (!registration) return;
        if (active) dispose = () => registration.dispose();
        else registration.dispose();
      });
    return () => {
      active = false;
      dispose();
    };
  }, [exposed]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("google");
    if (!result) return;
    flash(result === "connected" ? "Google account connected." : "Google account connection did not complete. Try again.");
    url.searchParams.delete("google");
    url.searchParams.delete("accountId");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  // ── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (typing) {
        if (event.key === "Escape") target?.blur();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLast();
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        setSideOpen((current) => !current);
        return;
      }
      if (overlay !== null || view !== "mail") return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && openKey) {
        event.preventDefault();
        setOpenKey(null);
        return;
      }
      const current = openMessage ?? messages[focus];
      if (event.key === "Enter" && !openKey && current) {
        event.preventDefault();
        openRow(current);
        return;
      }
      if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); step(1); return; }
      if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); step(-1); return; }
      if (!current) return;
      if (event.key === "x") {
        event.preventDefault();
        const key = messageKey(current);
        setSelected((currentSelection) => {
          const next = new Set(currentSelection);
          if (messageIsSelected(current, next)) {
            for (const identity of messageIdentityKeys(current)) next.delete(identity);
          } else next.add(key);
          return next;
        });
      }
      if (event.key === "e") {
        event.preventDefault();
        const targets = targetsFor(current);
        const folders = foldersByAccount.get(targets[0]?.ref.accountId ?? "") ?? [];
        const archive = folders.find((folder) => folder.specialUse === "archive");
        if (archive) applyTo(targets, { type: "move", destination: archive.path });
        else flash("This account has no Archive folder.");
      }
      if (event.key === "u") {
        event.preventDefault();
        applyTo(targetsFor(current), { type: current.read ? "mark_unread" : "mark_read" });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // ── Render ──────────────────────────────────────────────────────────
  const accountDrafts = drafts.filter((draft) => draft.accountId === composeAccountId);
  const overlayAccount = overlay && "accountId" in overlay && overlay.accountId !== "new"
    ? accounts.find(({ id }) => id === overlay.accountId) ?? null
    : null;
  const hasAccounts = accounts.length > 0;

  return <div className="shell">
    <div className="topbar">
      <span className="brand-group">
        <button
          className="icon-button"
          aria-label={sideOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sideOpen}
          title={`${sideOpen ? "Hide" : "Show"} sidebar   [`}
          onClick={() => setSideOpen((current) => !current)}
        >
          <PanelIcon filled={sideOpen} />
        </button>
        <span className="brand">PORTREEVE</span>
      </span>
      <span className="tabs">
        {tabs.map(([label, value]) => (
          <button key={value} className="opt opt-plain" aria-pressed={view === value} onClick={() => { setView(value); setOpenKey(null); }}>
            {label}
          </button>
        ))}
      </span>
      <span className="search">
        <span className="search-mark" aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          aria-label="Search messages"
          placeholder={scope?.kind === "unified" ? "Search all accounts   /" : "Search this folder   /"}
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            setQuery(queryDraft.trim());
            setFocus(0);
            setSelected(new Set());
            setLimit(50);
          }}
        />
        {queryDraft ? <button className="search-clear" aria-label="Clear search" onClick={() => { setQueryDraft(""); setQuery(""); }}>✕</button> : null}
      </span>
    </div>

    <div className="body-grid">
      {sideOpen ? <button className="side-scrim" aria-label="Close sidebar" onClick={() => setSideOpen(false)} /> : null}
      <div className="side" hidden={!sideOpen}>
        {hasAccounts ? <Sidebar
          accounts={accounts}
          foldersByAccount={foldersByAccount}
          awaitingByAccount={awaitingByAccount}
          scope={scope ?? { kind: "unified", specialUse: "inbox" }}
          filter={filter}
          view={view}
          section={section}
          sections={settingsSections}
          onScope={changeScope}
          onFilter={(next) => { setFilter(next); setFocus(0); setSelected(new Set()); }}
          onView={(next) => { setView(next); setOpenKey(null); }}
          onSection={(next) => setSection(next as SettingsSection)}
          onManageFolders={(accountId) => setOverlay({ kind: "folders", accountId })}
          onDrafts={() => {
            setOverlay({ kind: "drafts" });
            void queryClient.refetchQueries({ queryKey: ["drafts"], type: "active" });
          }}
          draftCount={accountDrafts.length}
        /> : null}
      </div>

      <div className="main">
        {!hasAccounts && !accountsQuery.isLoading ? <div className="pad" style={{ maxWidth: 620 }}>
          <h1 style={{ fontSize: 20, marginBottom: 10 }}>Connect your email</h1>
          <p className="t-body" style={{ marginBottom: 18 }}>
            Add a Gmail account with OAuth, or the IMAP and SMTP settings from any other provider. Postreeve tests both
            connections before saving anything, and credentials stay encrypted on this server.
          </p>
          <button className="btn" onClick={() => setOverlay({ kind: "account", accountId: "new" })}>Connect account</button>
        </div> : null}

        {hasAccounts && view === "mail" ? <div className={`mail-view ${openKey ? "has-reader" : ""}`}>
          <section className="mail-list-pane" aria-label="Mailbox list">
            <MessageList
              messages={messages}
              provenance={provenance}
              folders={scopeFolders}
              loading={messagesLoading}
              error={messagesError}
              focus={focus}
              selected={selected}
              openKey={openKey}
              title={scopeTitle}
              countLine={countLine(messages, { query, filter, awaiting: [...awaitingByAccount.values()].reduce((total, count) => total + count, 0) })}
              sort={sort}
              filter={filter}
              query={query}
              busy={busy || actionMutation.isPending}
              canLoadMore={messageResults.some((result) => (result.data?.length ?? 0) >= limit) && limit < 100}
              onSort={(next) => { setSort(next); setFocus(0); }}
              onOpen={openRow}
              onSelect={(message, modifiers) => {
                const key = messageKey(message);
                const index = messages.findIndex((candidate) => messageMatchesKey(candidate, key));
                if (modifiers.range) {
                  const [from, to] = [Math.min(focus, index), Math.max(focus, index)];
                  setSelected(new Set(messages.slice(from, to + 1).map(messageKey)));
                  return;
                }
                setFocus(index);
                setSelected((current) => {
                  const next = new Set(current);
                  if (messageIsSelected(message, next)) {
                    for (const identity of messageIdentityKeys(message)) next.delete(identity);
                  } else next.add(key);
                  return next;
                });
              }}
              onBulk={(action) => applyTo(targetsFor(messages[focus]), action)}
              onAcceptProposal={(proposalId) => acceptMutation.mutate(proposalId)}
              onCompose={() => composeAccountId && setOverlay({ kind: "compose", accountId: composeAccountId, intent: { mode: "new" } })}
              onLoadMore={() => setLimit((current) => Math.min(100, current + 50))}
              onRetry={() => void refresh()}
            />
          </section>

          {openKey ? <section className="mail-reader-pane" aria-label="Message reader">
            {detailQuery.data ? <Reader
              key={`${detailQuery.data.ref.accountId}:${detailQuery.data.canonicalId}`}
              message={detailQuery.data}
              folders={foldersByAccount.get(detailQuery.data.ref.accountId) ?? []}
              provenance={provenance.get(provenanceKey(detailQuery.data.ref))}
              folderName={folderName}
              position={`${focus + 1} of ${messages.length}`}
              busy={actionMutation.isPending}
              error={detailQuery.error?.message ?? null}
              canUndo={undoStack.length > 0}
              onClose={() => setOpenKey(null)}
              onStep={step}
              onAction={(action) => openMessage && applyTo([openMessage], action)}
              onAcceptProposal={(proposalId) => acceptMutation.mutate(proposalId)}
              onUndo={undoLast}
              onCompose={(mode) => detailQuery.data && setOverlay({
                kind: "compose",
                accountId: detailQuery.data.ref.accountId,
                intent: { mode, message: detailQuery.data },
              })}
              onDownloadAttachment={(attachment) => downloadReceivedAttachment(
                detailQuery.data!.ref.accountId,
                attachment,
              )}
            /> : <div className="pad t-dim">{detailQuery.isError ? detailQuery.error.message : "Loading message…"}</div>}
          </section> : null}
        </div> : null}

        {hasAccounts && view === "activity" ? <ActivityView
          batches={batches}
          loading={batchResults.some((result) => result.isLoading)}
          error={batchResults.find((result) => result.error)?.error?.message ?? null}
          actorFilter={actorFilter}
          undoing={undoMutation.isPending ? "pending" : null}
          onActorFilter={setActorFilter}
          onUndo={(batchId) => undoMutation.mutate([batchId])}
          onRetry={() => void refresh()}
        /> : null}

        {hasAccounts && view === "settings" ? <SettingsView
          section={section}
          accounts={accounts}
          foldersByAccount={foldersByAccount}
          googleConfigured={googleStatusQuery.data?.configured ?? false}
          themePreference={theme.preference}
          themeMode={theme.mode}
          hiddenTools={hiddenTools}
          onThemePreference={theme.setPreference}
          onToolExposure={(name, isExposed) => setHiddenTools((current) => {
            const next = new Set(current);
            if (isExposed) next.delete(name);
            else next.add(name);
            return next;
          })}
          onManageAccount={(accountId) => setOverlay({ kind: "account", accountId })}
          onManageIdentities={(accountId) => setOverlay({ kind: "identities", accountId })}
          onAddAccount={() => setOverlay({ kind: "account", accountId: "new" })}
        /> : null}
      </div>
    </div>

    {toast ? <div className="toast" role="status">
      <span>{toast}</span>
      {undoStack.length > 0 ? <button onClick={undoLast}>Undo ⌘Z</button> : null}
    </div> : null}

    {overlay?.kind === "account" ? <AccountSetup
      account={overlayAccount}
      onClose={() => setOverlay(null)}
      onSaved={(saved) => {
        setOverlay(null);
        const folders = foldersByAccount.get(saved.id) ?? [];
        changeScope({ kind: "account", accountId: saved.id, path: folders.find((folder) => folder.specialUse === "inbox")?.path ?? folders[0]?.path ?? "INBOX" });
      }}
      onRemoved={() => { setOverlay(null); setScope(null); }}
    /> : null}

    {overlay?.kind === "folders" && overlayAccount ? <FolderSheet
      account={overlayAccount}
      folders={foldersByAccount.get(overlayAccount.id) ?? []}
      onChange={(folders, previousPath, nextPath) => {
        queryClient.setQueryData(["folders", overlayAccount.id], folders);
        setScope((current) => current?.kind === "account" && current.path === previousPath
          ? { kind: "account", accountId: overlayAccount.id, path: nextPath ?? folders[0]?.path ?? "" }
          : current);
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      }}
      onClose={() => setOverlay(null)}
    /> : null}

    {overlay?.kind === "identities" && overlayAccount ? <IdentitySheet
      account={overlayAccount}
      identities={identities.filter((identity) => identity.accountId === overlayAccount.id)}
      onChange={(next) => setIdentities((current) => [...current.filter((identity) => identity.accountId !== overlayAccount.id), ...next])}
      onClose={() => setOverlay(null)}
    /> : null}

    {overlay?.kind === "drafts" ? <DraftsSheet
      drafts={accountDrafts}
      loaded={draftsLoaded}
      loading={draftsLoading}
      refreshing={draftsRefreshing}
      loadError={draftLoadError}
      onClose={() => setOverlay(null)}
      onCreate={() => setOverlay({ kind: "compose", accountId: composeAccountId, intent: { mode: "new" } })}
      onOpen={(draft) => setOverlay({ kind: "compose", accountId: draft.accountId, intent: { mode: "draft", draft } })}
      onRemove={async (draft) => {
        await api.removeDraft(draft.accountId, draft.id, { version: draft.version });
        queryClient.setQueryData<Draft[]>(["drafts", draft.accountId], (current = []) => current.filter(({ id }) => id !== draft.id));
      }}
    /> : null}

    {overlay?.kind === "compose" && accounts.find(({ id }) => id === overlay.accountId) ? <ComposeModal
      key={overlay.intent.draft?.id ?? "new-compose"}
      onCopied={(draft) => setOverlay({ kind: "compose", accountId: draft.accountId, intent: { mode: "draft", draft } })}
      account={accounts.find(({ id }) => id === overlay.accountId)!}
      identities={identities.filter((identity) => identity.accountId === overlay.accountId)}
      intent={overlay.intent}
      onClose={() => setOverlay(null)}
      onSaveDraft={(draft) => queryClient.setQueryData<Draft[]>(["drafts", draft.accountId], (current = []) => current.some(({ id }) => id === draft.id)
        ? current.map((candidate) => candidate.id === draft.id ? draft : candidate)
        : [draft, ...current])}
      onSent={(draftId) => {
        if (!draftId) return;
        queryClient.setQueryData<Draft[]>(["drafts", overlay.accountId], (current = []) => current.filter(({ id }) => id !== draftId));
      }}
    /> : null}
  </div>;
}

export default App;
