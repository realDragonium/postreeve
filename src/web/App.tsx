import type { MailboxPage, MailboxSource } from "../shared/mailbox-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Account, CanonicalMessageDetail, Draft, Folder, Identity, MessageSummary, ReceivedAttachment, TriageAction } from "../shared/contracts";
import { api } from "./api";
import { registerPostreeveWebMcp } from "../server/webmcp/register";
import { subscribeToWebMcpFolderLists, subscribeToWebMcpMailboxViews, subscribeToWebMcpProposalChanges, webMcpServices } from "./webmcp";
import { exposedToolNames, loadHiddenTools, storeHiddenTools } from "./assistant-tools";
import { ActivityView } from "./ActivityView";
import { MessageList } from "./MessageList";
import { Reader } from "./Reader";
import { conversationThread } from "./conversation-view";
import { Sidebar } from "./Sidebar";
import { SettingsView, settingsSections, type SettingsSection } from "./SettingsView";
import { useOwner } from "./AuthGate";
import { AccountSetup, ComposeModal, DraftsSheet, FolderSheet, IdentitySheet, type ComposeIntent } from "./panels";
import { ErrorBoundary } from "./ErrorBoundary";
import { ShortcutHelp } from "./ShortcutHelp";
import { goChordMs, isTypingTarget, shortcutCommand } from "./keyboard";
import { ConfirmDialog } from "./ConfirmDialog";
import { canDeletePermanently, emptyLabel, messageCount, purgeableFolder, type PurgeableUse } from "./permanent-delete";
import {
  countLine,
  messageIdentityKeys,
  messageIsSelected,
  messageKey,
  messageMatchesKey,
  mergeMessages,
  conversationGroups,
  expandGroups,
  scopeSources,
  applyPerAccount,
  folderIntentLabel,
  planFolderAction,
  spamToggle,
  specialUseName,
  type FolderIntent,
  type SpecialUse,
  type PlannedAction,
  type Scope,
} from "./mail-view";
import {
  agentBatchNames,
  buildProvenance,
  provenanceKey,
  recordUserBatch,
  type Actor,
} from "./provenance";
import {
  type MessageFilter,
  type MessageSort,
} from "./mail-ui-state";
import { migrateLocalDraftsOnce } from "./draft-state";
import { migrateLocalIdentitiesOnce } from "./identities";
import { useTheme } from "./theme";
import type { MailboxEvent } from "../shared/mailbox-events";
import { subscribeToMailboxEvents } from "./mailbox-events";
import {
  loadNotificationPreferences,
  notificationsFor,
  storeNotificationPreferences,
  type NotificationAccess,
  type NotificationPreferences,
  type PlannedNotification,
} from "./notifications";

const folderPollIntervalMs = 15_000;
/** Synchronization can commit several pages in a burst; refetch once per burst. */
const mailboxEventCoalesceMs = 1_000;
const groupedKey = "postreeve.message-list-grouped.v1";

function notificationAccess(): NotificationAccess {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}
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

/** A permanent delete waiting for the person's confirmation. */
type PendingPurge =
  | { readonly kind: "messages"; readonly accountId: string; readonly messages: readonly MessageSummary[]; readonly folderName: string }
  | { readonly kind: "folder"; readonly accountId: string; readonly path: string; readonly use: PurgeableUse; readonly total: number }
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
  const owner = useOwner();
  // The desktop app is authenticated by its launch token and has no owner sign-in to manage.
  const sections = owner.desktop ? settingsSections.filter((value) => value !== "Security") : settingsSections;

  const [view, setView] = useState<View>("mail");
  const [section, setSection] = useState<SettingsSection>("Accounts");
  const [scope, setScope] = useState<Scope | null>(null);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > narrowWidth);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MessageFilter>("all");
  const [sort, setSort] = useState<MessageSort>("newest");
  const [agentSources, setAgentSources] = useState<MailboxSource[] | null>(null);
  const [limit, setLimit] = useState(50);
  const [grouped, setGrouped] = useState(() => { try { return localStorage.getItem(groupedKey) === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(groupedKey, grouped ? "1" : "0"); } catch { /* storage unavailable */ } }, [grouped]);
  const [everywhere, setEverywhere] = useState(false);
  // Everywhere widens one search; a new view or a cleared search starts from the current folder again.
  useEffect(() => { if (!query) setEverywhere(false); }, [query]);
  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<readonly UndoEntry[]>([]);
  const [actorFilter, setActorFilter] = useState<Actor | "all">("all");
  const [hiddenTools, setHiddenTools] = useState<ReadonlySet<string>>(loadHiddenTools);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [purge, setPurge] = useState<PendingPurge>(null);
  useEffect(() => storeHiddenTools(hiddenTools), [hiddenTools]);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>(() => loadNotificationPreferences(localStorage));
  const [notificationPermission, setNotificationPermission] = useState<NotificationAccess>(notificationAccess);
  useEffect(() => storeNotificationPreferences(localStorage, notificationPreferences), [notificationPreferences]);

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
  const identityResults = useQueries({
    queries: accounts.map((account) => ({ queryKey: ["identities", account.id], queryFn: () => api.identities(account.id) })),
  });
  const identities: readonly Identity[] = identityResults.flatMap((result) => result.data ?? []);
  /**
   * Migrations run while the first list fetch may still be in flight. Invalidating a query that has no data yet joins
   * that fetch instead of restarting it, so the pre-migration result would stick; cancel it first.
   */
  async function refetchAfterMigration(queryKey: readonly string[]): Promise<void> {
    await queryClient.cancelQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey });
  }
  const migrationAccountSnapshot = accounts.map(({ id }) => id).sort().join("\0");
  const migratedAccountSnapshot = useRef<string | null>(null);
  useEffect(() => {
    if (!accountsQuery.isSuccess || migratedAccountSnapshot.current === migrationAccountSnapshot) return;
    migratedAccountSnapshot.current = migrationAccountSnapshot;
    void migrateLocalDraftsOnce(localStorage, accounts, api.createDraft).then(async ({ migrated }) => {
      if (migrated > 0) await refetchAfterMigration(["drafts"]);
    }).catch((error: unknown) => {
      migratedAccountSnapshot.current = null;
      flash(error instanceof Error ? error.message : "Local draft migration failed");
    });
    void migrateLocalIdentitiesOnce(localStorage, accounts, api.addIdentity).then(async ({ migrated }) => {
      if (migrated > 0) await refetchAfterMigration(["identities"]);
    }).catch((error: unknown) => {
      flash(error instanceof Error ? error.message : "Local identity migration failed");
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
  // Remote agents act without this page, so their calls come from the server's audit; a failure leaves attribution browser-local.
  const agentEventsQuery = useQuery({ queryKey: ["agent-events"], queryFn: ({ signal }) => api.agentEvents(signal), refetchInterval: 15_000 });
  const agentEvents = useMemo(() => agentEventsQuery.data ?? [], [agentEventsQuery.data]);
  const provenance = useMemo(() => buildProvenance(batches, proposals, agentBatchNames(agentEvents)), [batches, proposals, agentEvents]);
  const awaitingByAccount = new Map<string, number>(accounts.map((account, index) => [
    account.id,
    (proposalResults[index]?.data ?? [])
      .filter((proposal) => proposal.status === "draft" || proposal.status === "review" || proposal.status === "approved")
      .reduce((total, proposal) => total + proposal.items.length, 0),
  ]));

  // The first account list decides whether the unified view is even meaningful.
  useEffect(() => {
    if (scope !== null || agentSources !== null || accounts.length === 0) return;
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

  const sources = agentSources ?? (scope ? scopeSources(scope, foldersByAccount) : []);
  const searchScope = everywhere && query ? "everywhere" : "sources";
  const group = grouped ? "conversation" : "none";
  // Extra key parts only when set, so agent-driven views keep the key WebMCP writes into the cache.
  const messageQueryKey = ["messages", sources, query, filter, sort, limit, ...(searchScope === "everywhere" || grouped ? [searchScope, group] : [])];
  const messageResults = useInfiniteQuery({
    queryKey: messageQueryKey,
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.queryMessages({ sources: searchScope === "everywhere" ? [] : [...sources], scope: searchScope,
      query, filter, sort, limit, group, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    getNextPageParam: page => page.nextCursor,
    enabled: sources.length > 0 || searchScope === "everywhere",
  });
  const messages = mergeMessages((messageResults.data?.pages ?? []).map(page => page.messages));
  const groups = conversationGroups(messageResults.data?.pages ?? []);
  const messagesLoading = messageResults.isLoading;
  const messagesError = messageResults.error?.message ?? null;
  const busy = messageResults.isFetching;
  const coverage = messageResults.data?.pages.at(-1)?.coverage;
  const coverageText = coverage ? [
    coverage.sources.some(source => !source.synchronized) ? "Synchronization is incomplete; more messages may appear." : "",
    `${coverage.sources.reduce((total, source) => total + source.bodiesAvailable, 0)} of ${coverage.sources.reduce((total, source) => total + source.indexedMessages, 0)} indexed bodies available; body search is limited to ${coverage.bodyTextLimit.toLocaleString()} characters per message and retained content.`,
    messageResults.data?.pages.some(page => page.coverage.sources.some(source => source.fallback === "failed")) ? "Provider fallback failed; cached results remain available." : "",
    messageResults.data?.pages.some(page => page.coverage.sources.some(source => source.fallback === "limited")) ? "Provider fallback is limited and may omit matches." : "",
    messageResults.data?.pages[0]?.coverage.sources.some(source => source.fallback === "not-requested") ? "Provider fallback was skipped for some incomplete sources." : "",
  ].filter(Boolean).join(" ") : null;

  const openMessage = messages.find((message) => messageMatchesKey(message, openKey)) ?? null;
  const openConversationId = openMessage?.conversationId;
  const conversationQuery = useQuery({
    queryKey: ["conversation", openConversationId, openMessage?.ref.accountId],
    queryFn: ({ signal }) => api.conversationMessages(openConversationId ?? "", openMessage?.ref.accountId ?? "", signal),
    enabled: openConversationId !== undefined,
  });
  const thread = openMessage ? conversationThread(openMessage, conversationQuery.data) : [];

  const scopeAccountId = scope?.kind === "account" ? scope.accountId : null;
  const scopeFolders = scopeAccountId
    ? foldersByAccount.get(scopeAccountId) ?? []
    : (openMessage ? foldersByAccount.get(openMessage.ref.accountId) ?? [] : []);
  const folderName = scope === null ? ""
    : scope.kind === "unified" ? specialUseName(scope.specialUse)
    : (foldersByAccount.get(scope.accountId) ?? []).find((folder) => folder.path === scope.path)?.name ?? scope.path;
  const scopeTitle = agentSources && agentSources.length > 1 ? "Selected mailboxes" : scope === null ? "Mailbox"
    : scope.kind === "unified" ? `Unified · ${folderName}`
    : `${accounts.find((account) => account.id === scope.accountId)?.email ?? ""} · ${folderName}`;
  const composeAccountId = openMessage?.ref.accountId ?? scopeAccountId ?? accounts[0]?.id ?? "";

  // ── Operations ──────────────────────────────────────────────────────
  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["messages"] }),
      queryClient.invalidateQueries({ queryKey: ["message"] }),
      queryClient.invalidateQueries({ queryKey: ["conversation"] }),
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
    mutationFn: async ({ items }: { items: readonly PlannedAction[]; label: (count: number) => string; closesReader: boolean }) => {
      const outcome = await applyPerAccount(items, (accountId, group) => api.applyDirectActions({
        accountId,
        items: group.map(({ message, action }) => ({ message: message.ref, subject: message.subject, action })),
      }));
      if (outcome.applied.length === 0) throw new Error(outcome.failures.join(" "));
      return outcome;
    },
    onSuccess: async ({ applied, failures }, { label, closesReader }) => {
      for (const { batch } of applied) recordUserBatch(batch.id);
      const status = label(applied.reduce((total, { count }) => total + count, 0));
      setUndoStack((current) => [{ label: status, batchIds: applied.map(({ batch }) => batch.id) }, ...current].slice(0, 8));
      setSelected(new Set());
      if (closesReader) setOpenKey(null);
      flash(failures.length ? `${status}. Failed for ${failures.length} account${failures.length === 1 ? "" : "s"}: ${failures.join(" ")}` : status);
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

  const declineMutation = useMutation({
    mutationFn: (proposalId: string) => api.declineProposal(proposalId),
    onSuccess: async () => {
      flash("Declined proposal");
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

  const purgeMutation = useMutation({
    mutationFn: (pending: NonNullable<PendingPurge>) => pending.kind === "folder"
      ? api.emptyFolder(pending.accountId, pending.path)
      : api.deletePermanently(pending.accountId, pending.messages.map(({ ref }) => ref)),
    onSuccess: async ({ deleted }, pending) => {
      setPurge(null);
      setSelected(new Set());
      if (pending.kind === "folder" || pending.messages.some((message) => messageMatchesKey(message, openKey))) setOpenKey(null);
      flash(`Deleted ${messageCount(deleted)} permanently`);
      await refresh();
    },
  });

  function confirmDeleteForever(messagesToDelete: readonly MessageSummary[]): void {
    const [firstMessage] = messagesToDelete;
    if (!firstMessage) return;
    const folder = purgeableFolder(foldersByAccount.get(firstMessage.ref.accountId) ?? [], firstMessage.ref.mailbox);
    purgeMutation.reset();
    setPurge({ kind: "messages", accountId: firstMessage.ref.accountId, messages: messagesToDelete, folderName: folder?.name ?? firstMessage.ref.mailbox });
  }

  function undoLast(): void {
    const entry = undoStack[0];
    if (!entry || undoMutation.isPending) return;
    undoMutation.mutate(entry.batchIds);
  }

  function targetsFor(fallback: MessageSummary | undefined): MessageSummary[] {
    const chosen = messages.filter((message) => messageIsSelected(message, selected));
    return expandGroups(chosen.length ? chosen : fallback ? [fallback] : [], groups);
  }

  function applyTo(targets: readonly MessageSummary[], action: TriageAction): void {
    if (targets.length === 0) return;
    const label = (count: number): string => action.type === "move" ? `Moved ${count} to ${action.destination}`
      : action.type === "trash" ? `Moved ${count} to Trash`
      : action.type === "mark_read" ? `Marked ${count} read`
      : action.type === "flag" ? `Flagged ${count}`
      : action.type === "unflag" ? `Unflagged ${count}`
      : `Marked ${count} unread`;
    actionMutation.mutate({
      items: targets.map((message) => ({ message, action })),
      label,
      closesReader: action.type === "move" || action.type === "trash",
    });
  }

  function applyFolderAction(targets: readonly MessageSummary[], intent: FolderIntent): void {
    const plan = planFolderAction(targets, intent, foldersByAccount);
    if (plan.items.length > 0) {
      actionMutation.mutate({ items: plan.items, label: (count) => folderIntentLabel(intent, count), closesReader: true });
    } else if (plan.missingFolder > 0) {
      flash(intent === "archive" ? "This account has no Archive folder."
        : intent === "spam" ? "This account has no Junk folder."
        : "This account has no Inbox folder.");
    }
  }

  function spamIntent(message: MessageSummary): FolderIntent {
    return spamToggle(message, foldersByAccount.get(message.ref.accountId) ?? []).label === "Not spam" ? "not_spam" : "spam";
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
    setAgentSources(null);
    setScope(next);
    if (window.innerWidth <= narrowWidth) setSideOpen(false);
    setView("mail");
    setOpenKey(null);
    setFocus(0);
    setSelected(new Set());
    setLimit(50);
  }

  async function enableNotifications(enabled: boolean): Promise<void> {
    if (!enabled) {
      setNotificationPreferences((current) => ({ ...current, enabled: false }));
      return;
    }
    if (typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      return;
    }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setNotificationPermission(permission);
    if (permission === "granted") setNotificationPreferences((current) => ({ ...current, enabled: true }));
  }

  function openNotification({ accountId, mailbox, canonicalId }: PlannedNotification["open"]): void {
    window.focus();
    changeScope({ kind: "account", accountId, path: mailbox });
    setQueryDraft("");
    setQuery("");
    setFilter("all");
    if (canonicalId) setOpenKey(canonicalId);
  }

  // ── Mailbox events ──────────────────────────────────────────────────
  const changedAccounts = useRef(new Set<string>());
  const changeTimer = useRef<number>(0);
  const handleMailboxEvent = useRef<(event: MailboxEvent) => void>(() => undefined);
  handleMailboxEvent.current = (event) => {
    changedAccounts.current.add(event.accountId);
    window.clearTimeout(changeTimer.current);
    changeTimer.current = window.setTimeout(() => {
      const accountIds = [...changedAccounts.current];
      changedAccounts.current.clear();
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation"] });
      for (const accountId of accountIds) void queryClient.invalidateQueries({ queryKey: ["folders", accountId] });
    }, mailboxEventCoalesceMs);
    const account = accounts.find(({ id }) => id === event.accountId);
    if (!account) return;
    const planned = notificationsFor(event, notificationPreferences, {
      access: notificationAccess(), focused: document.hasFocus(), accountLabel: account.email,
    });
    for (const { title, body, tag, open } of planned) {
      const notification = new Notification(title, { body, tag });
      notification.onclick = () => {
        notification.close();
        openNotification(open);
      };
    }
  };
  useEffect(() => subscribeToMailboxEvents((event) => handleMailboxEvent.current(event)), []);

  // ── WebMCP ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribeViews = subscribeToWebMcpMailboxViews((incoming) => {
      const incomingSources = incoming.sources ?? [{ accountId: incoming.accountId, mailbox: incoming.mailbox }];
      const key = ["messages", incomingSources, incoming.query, incoming.filter, incoming.sort, incoming.limit];
      const page: MailboxPage = { messages: [...incoming.messages], nextCursor: incoming.nextCursor, coverage: incoming.coverage };
      queryClient.setQueryData<{ pages: MailboxPage[]; pageParams: (string | null)[] }>(key, current =>
        incoming.cursor && current ? { pages: [...current.pages, page], pageParams: [...current.pageParams, incoming.cursor] }
          : { pages: [page], pageParams: [incoming.cursor ?? null] });
      setAgentSources(incomingSources);
      setEverywhere(false);
      setScope(incomingSources.length > 1 ? null : { kind: "account", accountId: incoming.accountId, path: incoming.mailbox });
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
    const unsubscribeProposals = subscribeToWebMcpProposalChanges((accountId, kind) => {
      void queryClient.invalidateQueries({ queryKey: [kind, accountId] });
    });
    return () => {
      unsubscribeViews();
      unsubscribeFolders();
      unsubscribeProposals();
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
  function composeFrom(mode: "reply" | "reply_all" | "forward", message: MessageSummary): void {
    // The reader caches each expanded message's detail under this key; a list-only shortcut fetches it.
    void queryClient.fetchQuery({
      queryKey: ["message", messageKey(message), message.ref],
      queryFn: async () => (await api.readMessages([message.ref]))[0] ?? null,
    }).then((detail: CanonicalMessageDetail | null) => {
      if (!detail) throw new Error("This message is no longer available");
      setOverlay({ kind: "compose", accountId: detail.ref.accountId, intent: { mode, message: detail } });
    }).catch((error: unknown) => flash(error instanceof Error ? error.message : "The message could not be loaded"));
  }

  function goTo(specialUse: SpecialUse): void {
    if (scope?.kind !== "account") {
      changeScope({ kind: "unified", specialUse });
      return;
    }
    const folder = (foldersByAccount.get(scope.accountId) ?? []).find((candidate) => candidate.specialUse === specialUse);
    if (folder) changeScope({ kind: "account", accountId: scope.accountId, path: folder.path });
    else flash(`This account has no ${specialUseName(specialUse)} folder.`);
  }

  function trashable(message: MessageSummary): boolean {
    const folders = foldersByAccount.get(message.ref.accountId) ?? [];
    return folders.some((folder) => folder.specialUse === "trash" && folder.path !== message.ref.mailbox);
  }

  const goChord = useRef(0);
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) {
        if (event.key === "Escape") (event.target as HTMLElement).blur();
        return;
      }
      if (helpOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setHelpOpen(false);
        }
        return;
      }
      if (overlay !== null || purge !== null) return;
      const chord = goChord.current > Date.now();
      goChord.current = 0;
      const command = shortcutCommand(event, chord);
      if (command === null) return;

      switch (command) {
        case "undo": event.preventDefault(); undoLast(); return;
        case "toggle_sidebar": event.preventDefault(); setSideOpen((current) => !current); return;
        case "help": event.preventDefault(); setHelpOpen(true); return;
        case "go": event.preventDefault(); goChord.current = Date.now() + goChordMs; return;
        case "go_inbox": event.preventDefault(); goTo("inbox"); return;
        case "go_sent": event.preventDefault(); goTo("sent"); return;
        case "go_drafts": event.preventDefault(); goTo("drafts"); return;
        case "go_trash": event.preventDefault(); goTo("trash"); return;
        case "compose":
          event.preventDefault();
          if (composeAccountId) setOverlay({ kind: "compose", accountId: composeAccountId, intent: { mode: "new" } });
          return;
        default: break;
      }

      if (view !== "mail") return;
      if (command === "search") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (command === "close") {
        if (!openKey) return;
        event.preventDefault();
        setOpenKey(null);
        return;
      }
      const current = openMessage ?? messages[focus];
      if (command === "open") {
        if (openKey || !current) return;
        event.preventDefault();
        openRow(current);
        return;
      }
      if (command === "next") { event.preventDefault(); step(1); return; }
      if (command === "previous") { event.preventDefault(); step(-1); return; }
      if (!current) return;
      event.preventDefault();
      switch (command) {
        case "select": {
          const key = messageKey(current);
          setSelected((currentSelection) => {
            const next = new Set(currentSelection);
            if (messageIsSelected(current, next)) {
              for (const identity of messageIdentityKeys(current)) next.delete(identity);
            } else next.add(key);
            return next;
          });
          return;
        }
        case "archive": applyFolderAction(targetsFor(current), "archive"); return;
        case "spam": applyFolderAction(targetsFor(current), spamIntent(current)); return;
        case "toggle_read": applyTo(targetsFor(current), { type: current.read ? "mark_unread" : "mark_read" }); return;
        case "mark_unread": applyTo(targetsFor(current), { type: "mark_unread" }); return;
        case "toggle_flag": applyTo(targetsFor(current), { type: current.flagged ? "unflag" : "flag" }); return;
        case "trash": {
          const targets = targetsFor(current).filter(trashable);
          if (targets.length > 0) applyTo(targets, { type: "trash" });
          return;
        }
        case "reply": composeFrom("reply", current); return;
        case "reply_all": composeFrom("reply_all", current); return;
        case "forward": composeFrom("forward", current); return;
        default: return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // The phone back gesture should close the reader, not leave the app.
  const readerHistoryEntry = useRef(false);
  useEffect(() => {
    if (openKey && !readerHistoryEntry.current) {
      window.history.pushState({ ...(window.history.state as object | null), postreeveReader: true }, "");
      readerHistoryEntry.current = true;
    } else if (!openKey && readerHistoryEntry.current) {
      readerHistoryEntry.current = false;
      if ((window.history.state as { postreeveReader?: boolean } | null)?.postreeveReader) window.history.back();
    }
  }, [openKey]);
  useEffect(() => {
    function onPop(): void {
      if (!readerHistoryEntry.current) return;
      readerHistoryEntry.current = false;
      setOpenKey(null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  const accountDrafts = drafts.filter((draft) => draft.accountId === composeAccountId);
  const overlayAccount = overlay && "accountId" in overlay && overlay.accountId !== "new"
    ? accounts.find(({ id }) => id === overlay.accountId) ?? null
    : null;
  const hasAccounts = accounts.length > 0;
  const showSecurity = view === "settings" && section === "Security" && !owner.desktop;
  const scopeAccount = scopeAccountId ? accounts.find(({ id }) => id === scopeAccountId) : undefined;
  const scopePurgeable = scope?.kind === "account" ? purgeableFolder(scopeFolders, scope.path) : null;
  const purgeSelection = scopePurgeable ? messages.filter((message) => messageIsSelected(message, selected)) : [];
  const purgeStrip = scopeAccount && scopePurgeable ? <div className="purge-strip" role="region" aria-label="Permanent delete">
    {canDeletePermanently(scopeAccount) ? <>
      <span className="t-dim">Messages deleted here are gone for good.</span>
      {purgeSelection.length > 0 ? <button className="chip btn-danger" onClick={() => confirmDeleteForever(purgeSelection)}>
        Delete {messageCount(purgeSelection.length)} forever
      </button> : null}
      <button
        className="chip btn-danger"
        disabled={scopePurgeable.total === 0 && messages.length === 0}
        onClick={() => {
          purgeMutation.reset();
          setPurge({ kind: "folder", accountId: scopeAccount.id, path: scopePurgeable.path, use: scopePurgeable.specialUse, total: scopePurgeable.total });
        }}
      >{emptyLabel(scopePurgeable.specialUse)}</button>
    </> : <span className="t-dim">Gmail removes messages from {scopePurgeable.specialUse === "trash" ? "Trash" : "Spam"} after 30 days. Postreeve's Gmail access cannot delete mail permanently.</span>}
  </div> : null;

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
        <span className="brand">POSTREEVE</span>
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
          sections={sections}
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
        {!hasAccounts && !accountsQuery.isLoading && !showSecurity ? <div className="pad" style={{ maxWidth: 620 }}>
          <h1 style={{ fontSize: 20, marginBottom: 10 }}>Connect your email</h1>
          <p className="t-body" style={{ marginBottom: 18 }}>
            Add a Gmail account with OAuth, or the IMAP and SMTP settings from any other provider. Postreeve tests both
            connections before saving anything, and credentials stay encrypted on this server.
          </p>
          <button className="btn" onClick={() => setOverlay({ kind: "account", accountId: "new" })}>Connect account</button>
          {owner.desktop ? null : <p className="t-dim" style={{ marginTop: 18 }}>
            <button className="btn-quiet" onClick={() => { setView("settings"); setSection("Security"); }}>Passkeys, password and sessions</button>
          </p>}
        </div> : null}

        {hasAccounts && view === "mail" ? <div className={`mail-view ${openKey ? "has-reader" : ""}`}>
          <section className="mail-list-pane" aria-label="Mailbox list">
            {purgeStrip}
            <MessageList
              messages={messages}
              provenance={provenance}
              folders={scopeFolders}
              foldersByAccount={foldersByAccount}
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
              coverageText={coverageText}
              groups={groups}
              grouped={grouped}
              everywhere={everywhere}
              onGrouped={(next) => { setGrouped(next); setFocus(0); setSelected(new Set()); }}
              onEverywhere={(next) => { setEverywhere(next); setFocus(0); setSelected(new Set()); }}
              pageSize={limit}
              canLoadMore={messageResults.hasNextPage}
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
              onFolderAction={(intent) => applyFolderAction(targetsFor(messages[focus]), intent)}
              onAcceptProposal={(proposalId) => acceptMutation.mutate(proposalId)}
              onCompose={() => composeAccountId && setOverlay({ kind: "compose", accountId: composeAccountId, intent: { mode: "new" } })}
              onLoadMore={() => void messageResults.fetchNextPage()}
              onRetry={() => void refresh()}
            />
          </section>

          {openKey ? <section className="mail-reader-pane" aria-label="Message reader">
            <ErrorBoundary label="reader" retry resetKeys={[openKey]}>
            {openMessage ? <Reader
              key={openKey}
              message={openMessage}
              thread={thread}
              folders={foldersByAccount.get(openMessage.ref.accountId) ?? []}
              provenance={provenance.get(provenanceKey(openMessage.ref))}
              folderName={folderName}
              position={`${focus + 1} of ${messages.length}`}
              busy={actionMutation.isPending}
              canUndo={undoStack.length > 0}
              onClose={() => setOpenKey(null)}
              onStep={step}
              onAction={(action) => applyTo([openMessage], action)}
              onAcceptProposal={(proposalId) => acceptMutation.mutate(proposalId)}
              onDeclineProposal={(proposalId) => declineMutation.mutate(proposalId)}
              onUndo={undoLast}
              onCompose={(mode, source) => setOverlay({
                kind: "compose",
                accountId: source.ref.accountId,
                intent: { mode, message: source },
              })}
              onDownloadAttachment={downloadReceivedAttachment}
              {...(purgeableFolder(foldersByAccount.get(openMessage.ref.accountId) ?? [], openMessage.ref.mailbox)
                && canDeletePermanently(accounts.find(({ id }) => id === openMessage.ref.accountId))
                ? { onDeleteForever: () => confirmDeleteForever([openMessage]) } : {})}
            /> : <div className="pad t-dim">Loading message…</div>}
            </ErrorBoundary>
          </section> : null}
        </div> : null}

        {hasAccounts && view === "activity" ? <ActivityView
          batches={batches}
          agentEvents={agentEvents}
          accounts={accounts}
          loading={batchResults.some((result) => result.isLoading)}
          error={batchResults.find((result) => result.error)?.error?.message ?? null}
          actorFilter={actorFilter}
          undoing={undoMutation.isPending ? "pending" : null}
          onActorFilter={setActorFilter}
          onUndo={(batchId) => undoMutation.mutate([batchId])}
          onRetry={() => void refresh()}
        /> : null}

        {(hasAccounts || showSecurity) && view === "settings" ? <SettingsView
          section={section}
          accounts={accounts}
          foldersByAccount={foldersByAccount}
          googleConfigured={googleStatusQuery.data?.configured ?? false}
          themePreference={theme.preference}
          themeMode={theme.mode}
          hiddenTools={hiddenTools}
          onThemePreference={theme.setPreference}
          notificationPreferences={notificationPreferences}
          notificationPermission={notificationPermission}
          onEnableNotifications={(enabled) => void enableNotifications(enabled)}
          onMuteAccount={(accountId, muted) => setNotificationPreferences((current) => ({
            ...current,
            mutedAccountIds: muted
              ? [...new Set([...current.mutedAccountIds, accountId])]
              : current.mutedAccountIds.filter((id) => id !== accountId),
          }))}
          onToolExposure={(name, isExposed) => setHiddenTools((current) => {
            const next = new Set(current);
            if (isExposed) next.delete(name);
            else next.add(name);
            return next;
          })}
          onManageAccount={(accountId) => setOverlay({ kind: "account", accountId })}
          onManageIdentities={(accountId) => setOverlay({ kind: "identities", accountId })}
          onAddAccount={() => setOverlay({ kind: "account", accountId: "new" })}
          onShowShortcuts={() => setHelpOpen(true)}
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
      onChange={(next) => queryClient.setQueryData<Identity[]>(["identities", overlayAccount.id], next)}
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

    {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}

    {purge ? <ConfirmDialog
      title={purge.kind === "folder" ? `${emptyLabel(purge.use)}?` : `Delete ${messageCount(purge.messages.length)} forever?`}
      confirmLabel={purge.kind === "folder" ? emptyLabel(purge.use) : "Delete forever"}
      busy={purgeMutation.isPending}
      error={purgeMutation.error?.message ?? null}
      onCancel={() => setPurge(null)}
      onConfirm={() => purgeMutation.mutate(purge)}
    >
      <p className="t-body" style={{ margin: 0, fontSize: 13 }}>
        {purge.kind === "folder"
          ? `Every message in ${purge.use === "trash" ? "Trash" : "Spam"} for ${accounts.find(({ id }) => id === purge.accountId)?.email ?? "this account"} (${messageCount(purge.total)} by the last count) will be deleted from the mail server.`
          : purge.messages.length === 1
            ? `“${purge.messages[0]!.subject || "(No subject)"}” will be deleted from ${purge.folderName} on the mail server.`
            : `${messageCount(purge.messages.length)} will be deleted from ${purge.folderName} on the mail server.`}
      </p>
      <p className="t-body" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>This cannot be undone.</p>
    </ConfirmDialog> : null}

    {overlay?.kind === "compose" && accounts.find(({ id }) => id === overlay.accountId) ? <ErrorBoundary label="compose window" retry resetKeys={[overlay.intent]} onDismiss={() => setOverlay(null)}><ComposeModal
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
    /></ErrorBoundary> : null}
  </div>;
}

export default App;
