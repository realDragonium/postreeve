# Proposal

## Why
Postreeve is meant to replace Apple Mail for someone with many addresses, but new mail can take a minute or more to appear: synchronization polls every 60 seconds, an IMAP Inbox rescan walks every UID before new mail is reached, the message list only refreshes after local actions, and nothing tells the person that mail arrived. No Linear issue; part of the daily-driver effort.

## What Changes
- IMAP: one IDLE connection per account on INBOX when the server advertises IDLE. EXISTS, EXPUNGE and FETCH notifications expedite that mailbox's existing durable synchronization scope. The watch re-IDLEs every 25 minutes, reconnects with bounded backoff, stops for removed, unavailable, canceled or reauthorization-required accounts, and leaves polling as the fallback when IDLE is missing.
- IMAP: a new mailbox scan first ingests UIDs above the last completed scan before walking the rest, so new mail lands on the first page.
- Gmail: account history is polled every 20 seconds instead of 60. Pub/Sub push is out of scope.
- Synchronization detects new arrivals: unread Inbox messages first indexed after that scope completed a snapshot. Backfill, repair and moves of known messages are not arrivals.
- The server streams mailbox-change and new-mail events to the open page over Server-Sent Events at `/api/events`. This works through the desktop bearer-token proxy and the existing `connect-src 'self'` policy. The page refreshes lists and folder counts on change events. The 15-second folder poll stays as a fallback.
- Desktop notifications for arrivals use the Web Notification API, which Electron shows as native notifications. A Notifications settings section turns them on or off (permission is requested from that click) and mutes accounts. Clicking a notification opens the message. Notifications are suppressed while the window has focus and collapsed into one summary when many arrive together.
- README and FEATURES.md describe the new behavior.

## Capabilities
### New Capabilities
- `mailbox/new-mail-notifications`: arrival detection, the page event stream, notifications and their settings.

### Modified Capabilities
- `mailbox/synchronization`: provider change watches expedite durable scopes.
- `mailbox/imap-synchronization`: IDLE watch with fallback; arrivals-first scans.
- `mailbox/gmail-synchronization`: shorter history poll interval.
- `mailbox/folders`: counts also refresh on synchronization change events.
- `mailbox/message-listing`: visible lists refresh on synchronization change events.
- `runtime/local-server`: long-lived event stream behind the same optional bearer token.
- `runtime/desktop-app`: the event stream passes through the protocol proxy.

WebMCP tools are unchanged: notifications and the event stream are page-local presentation, not a mailbox workflow an agent performs.

## Impact
`src/server/mail/imap.ts` and a new IMAP IDLE watch, `imap-synchronization.ts`, `sync/runner.ts`, `sync/store.ts`, a new sync event hub, `api.ts`, `index.ts`, shared contracts, and in the web app `App.tsx`, `SettingsView.tsx`, `api.ts` plus a small event-stream client and notification module. No new dependencies, no database migration, no change to provider mail. Up to one extra long-lived IMAP connection per IMAP account.
