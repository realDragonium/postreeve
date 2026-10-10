# Tasks

## 1. Synchronization core

- [x] 1.1 Add `SynchronizationStore.expedite` and make `commit` return new arrivals (ready scope, new canonical id, unread, INBOX), with store tests for backfill, ready scope, repair/move and read mail
- [x] 1.2 Add the `MailboxEvents` hub and shared event schemas; runner publishes `mailbox-changed`/`new-mail` after commits
- [x] 1.3 Add `runner.expedite`, `gmailPollMs` (20 s) for Gmail claims, and runner tests for expedite wake-up, paused jobs and Gmail due time

## 2. Provider watches

- [x] 2.1 Add optional `MailProvider.watchChanges` and `ProviderWatches` reconciliation driven by runner ticks, with tests for start, stop on cancel/unavailable/reauthorization/removal and restart on provider replacement
- [x] 2.2 Implement `ImapInboxWatch` (IDLE capability check, INBOX events, catch-up on connect, 25 min re-IDLE, capped backoff) and wire it into `ImapMailProvider`, with fake-client tests
- [x] 2.3 Arrivals-first page in IMAP scans, with tests that a large completed mailbox ingests a new UID on the first page and then resumes a normal scan

## 3. Server and desktop transport

- [x] 3.1 Add `GET /api/events` SSE route with 15 s keep-alive and `Bun.serve` `idleTimeout: 60`; API test that events stream and the bearer token is enforced
- [x] 3.2 Forward the request abort signal through the desktop protocol proxy

## 4. Web interface

- [x] 4.1 Event-stream client (fetch streaming, SSE parser, reconnect backoff) with parser tests
- [x] 4.2 Notification preferences and pure `notificationsFor` decision with tests
- [x] 4.3 Wire events into App: coalesced list/folder invalidation, notifications with click-to-open
- [x] 4.4 Notifications settings section (enable with permission request, per-account mute, denied state)

## 5. Documentation and verification

- [x] 5.1 Update README and FEATURES.md
- [x] 5.2 Run `bun run typecheck`, `bun run test`, `bun run build`, `bunx openspec validate --specs --strict` and e2e if a browser is available; exercise the event stream and settings in the running app with test doubles

## Workflow follow-up

- Archive with `/opsx:archive` in the same branch, rebase on origin/main, open a PR.
