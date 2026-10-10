# Proposal

## Why

Review of the daily-driver work found two hardening gaps. First, the loopback server accepts any `Host` header, so a web page can DNS-rebind its own domain to `127.0.0.1` and use the unauthenticated API to read mail, send mail or trigger outbound autoconfig requests. Second, the IMAP Sent copy is appended before a sent draft is recorded as `sent`, over a connection with imapflow's long default timeouts; a stalled IMAP server holds the send open for minutes, and a restart in that window turns a delivered draft into `uncertain`.

## What Changes

- The server rejects every request whose `Host` is not a loopback name (`127.0.0.1`, `localhost`, `[::1]`) or the configured `POSTREEVE_HOST`, with 403.
- The server rejects state-changing API requests whose `Origin` is not the origin of the requested host, with 403, unless the desktop token is in force.
- A sent draft is recorded as `sent` before its Sent copy is appended; a copy failure updates the stored receipt's warning afterwards.
- Appending a Sent copy uses bounded IMAP connection, greeting and socket-inactivity timeouts, so a stalled server ends in the existing Sent-copy warning.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime/local-server`: adds Host allowlist and cross-site Origin rejection requirements.
- `compose/sending`: adds bounded IMAP timeouts for saving a Sent copy.
- `compose/drafts`: adds a requirement that the draft is recorded `sent` before the Sent copy is attempted.

## Impact

- `src/server/index.ts`, new `src/server/security/request-origin.ts` middleware and its tests.
- `src/server/core/postreeve.ts` send flow, `src/server/db/store.ts` (receipt warning update), `src/server/mail/imap.ts` (timeouts on the append path).
- Unchanged: Electron protocol proxy, Vite dev proxy, Compose publishing, Google OAuth callback; all keep working because they present a loopback `Host`.
