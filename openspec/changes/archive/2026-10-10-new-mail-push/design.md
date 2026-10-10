# Design

## Context

- `SynchronizationRunner` claims one durable account job per tick, runs one page of the earliest due scope, and commits through `SynchronizationStore`. It ticks every second while idle and immediately while it has work. A completed page makes its scope due again after `pollMs` (60 s).
- IMAP pages open a fresh connection. Every new scan of a mailbox walks UIDs `1..uidNext-1` in pages of 100, so new mail in a large Inbox shows up only on the last page.
- `sync_scans.completed_generation` is set once a mailbox (IMAP) or account (Gmail) scope completes a snapshot, and is cleared when a repair replaces the job.
- Nothing pushes data to the page. `connect-src 'self'` allows same-origin fetches. The desktop window reaches the sidecar only through the `postreeve://` protocol proxy, which adds the bearer token, so `EventSource` against the sidecar port is not an option.

## Goals / Non-Goals

**Goals:** mail arrival to visible list in a few seconds for IDLE-capable IMAP accounts and about 20 s for Gmail. One ingestion path. No schema migration.

**Non-Goals:** Gmail Pub/Sub, IDLE on folders other than INBOX, NOTIFY (RFC 5465), server-side notification preferences, notification sounds or badges, WebMCP exposure.

## Decisions

1. **Expedite durable scopes, not a parallel fetch.** A watch event calls `runner.expedite(accountId, mailbox)`. In one transaction the store sets that scope's `due_at = MIN(due_at, now)` and the job's `due_at = MIN(due_at, now)` only when the job is `queued` and the provider is available. Retry, canceled and reauthorization states are untouched. A running job picks the scope up in `finish`, which already takes the minimum scope due time. The runner then reschedules its tick to run immediately. *Alternative:* fetch new UIDs directly in the watcher and commit them. Rejected because it duplicates checkpoint, claim and snapshot rules.

2. **Watches are reconciled by the runner.** `MailProvider` gains an optional `watchChanges(onChange): { stop(): void }`. A small `ProviderWatches` class keeps one watch per account and runs on every runner tick from `store.jobs()`. It starts a watch for each job that has a registered provider and is not canceled, unavailable or `retry` with `reauthorization`. It stops a watch when that no longer holds or when the registry returns a different provider instance, which happens after reauthorization re-registers the account. This covers removal, reauthorization and unavailable accounts without new hooks in `PostreeveService`. Ticks are at most once a second while idle and `jobs()` reads about 10 rows, so the cost is negligible.

3. **IMAP watch connection.** `ImapInboxWatch` creates its own ImapFlow client with `maxIdleTime: 25 min` (re-IDLE before the 29-minute limit) and a short `autoIdleDelay`. It checks `capabilities.has("IDLE")`, opens INBOX read-only, and turns `exists`, `expunge` and `flags` events into `onChange("INBOX")`. It also calls `onChange` once per successful connect to catch up after a gap. Without IDLE it logs out and stops for good, and the entry stays in `ProviderWatches` so it is not restarted. On close or error it reconnects after `min(5 s × 2^failures, 15 min)`. The failure count resets only after a connection has lived at least 60 s, so a server that accepts and drops at once is still backed off. Authentication failures follow the same backoff. The next regular sync marks the job for reauthorization, and reconciliation then stops the watch. Client factory, delay and clock are injected for tests. ImapFlow's socket-timeout NOOP keeps the idle socket alive.

4. **Connection budget.** Ten IMAP accounts mean ten long-lived connections, one per account (a different login each). The existing per-page sync connections are short-lived. Per-user server limits (usually 10 to 20 or more) are not approached. Gmail accounts use the API and open none.

5. **Arrivals-first IMAP scans.** When `fetchPage` would start a new scan (`scan === null`, `through > 0`) and `uidNext - 1 > through`, it first runs `UID SEARCH through+1:uidNext-1`. It emits up to `limit` of those messages with no snapshot, and returns `through = last emitted UID` (or `uidNext - 1` when the search finds none), `hasMore: true` and `coverage: "complete"`. The next page starts the normal scan. A later CONDSTORE scan may fetch those UIDs again as modified, which is harmless. The cursor shape is unchanged. *Alternative:* scan in descending UID order. Rejected because it rewrites the cursor and snapshot logic.

6. **Gmail poll.** The runner takes `gmailPollMs` (default `min(20 s, pollMs)`, so Gmail never polls less often than other providers) and passes it instead of `pollMs` to `commit`/`finish` for Gmail claims. Retry backoff still uses `pollMs`. One `history.list` call per account every 20 s is far inside Gmail quota.

7. **Arrival detection lives in `store.commit`.** Before applying the page, commit reads whether the scope has a `completed_generation`. For each message after reconcile it checks whether `indexed_messages` already had that canonical id, tracking ids first seen in this page so that a later Gmail label row of the same message still counts as new. An arrival is a message that is new, unread, in `INBOX` (case-insensitive) and in a ready scope. Commit returns the arrivals (canonical id, ref, sender, subject, received time). Keying on canonical identity, not location, makes moves and repairs silent.

8. **Event hub and SSE.** `MailboxEvents` is an in-process publish/subscribe. After each commit the runner publishes `mailbox-changed` when the page had messages, removals, moves or a completing snapshot, and `new-mail` when arrivals exist. Shared zod schemas in `src/shared/mailbox-events.ts` describe both. `GET /api/events` uses Hono `streamSSE`, writes each event as `data: <json>`, and writes a comment keep-alive every 15 s. Bun's default 10 s `idleTimeout` would cut that, so `Bun.serve` sets `idleTimeout: 60`.

9. **Page client uses `fetch` streaming, not `EventSource`.** `fetch` is the request path the desktop proxy and `supportFetchAPI` already support. A small parser handles the SSE framing. The subscription reconnects after `min(1 s × 2^n, 30 s)` and parses each event with the shared schema. The desktop proxy already returns the `net.fetch` response body as a stream. It also forwards the request's abort signal so a reloaded page does not leave stale backend streams.

10. **Notifications in the renderer.** Use the Web Notification API in both browser and Electron. Electron shows these as native notifications, which avoids adding a preload and IPC to a sandboxed window. Preferences (`enabled`, `mutedAccountIds`) live in `localStorage`, like theme and tool exposure. A pure `notificationsFor(event, preferences, context)` decides what to show: skip when disabled, muted, permission not granted or the document has focus, and summarize when there are more than three. `tag` is the canonical id, so several open tabs collapse into one notification. On click: `window.focus()`, select the account's Inbox, clear search and filter, and open the canonical id. UI events are coalesced over one second before list and folder queries are invalidated.

## Risks / Trade-offs

- [Electron streaming of `protocol.handle` responses or notification click focus behaves differently than expected] → Both are verified by hand in the desktop app when possible. The 15 s folder poll and the focus behavior of macOS notification clicks remain as fallbacks.
- [An IMAP scan already in progress delays arrivals until it finishes] → Accepted. The common case (idle mailbox, then IDLE event) takes the arrivals-first path.
- [A message whose canonical identity changes (no Message-ID, UIDVALIDITY reset) is seen as new] → UIDVALIDITY resets clear the scan state, so the scope is not ready and nothing is notified. The remaining cases produce one notification per message, capped by the summary rule.
- [One extra connection per IMAP account] → See decision 4. Watches stop with the account.

## Migration Plan

No data migration. Notifications default to off. Rollback is reverting the change, because watches and streams hold no persisted state.
