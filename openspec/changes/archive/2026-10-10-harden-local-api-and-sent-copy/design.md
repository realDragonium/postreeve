# Design

## Context

`src/server/index.ts` composes Hono middleware: secure headers, then `desktopApiAuthentication` on `/api/*`, then the API and static files. Clients that must keep working:

- Browser at `http://127.0.0.1:3000` (Host `127.0.0.1:3000`).
- Vite dev/e2e proxy (`/api` → `http://localhost:3000`, no `changeOrigin`), which forwards the browser's Host, e.g. `127.0.0.1:4187`.
- Electron `postreeve://` proxy: `net.fetch` to `http://127.0.0.1:<port>` with the launch bearer token; the renderer's `Origin` (`postreeve://app`) may be forwarded.
- Google OAuth callback on `http://127.0.0.1:<port>`.
- Docker Compose: the server binds `0.0.0.0` in the container; the host publishes `127.0.0.1:3000:3000`, so the Host is `127.0.0.1:3000`, though a user may remap the host port.

`sendDraft` claims the draft, then `#dispatchMessageSend` sends via SMTP, records the conversation and appends the Sent copy before returning, and only then does `settleDraftSend` mark `sent`. IMAP clients use imapflow defaults (connection 90 s, greeting 16 s, socket inactivity 300 s); the repository has no shared IMAP timeout constant.

## Goals / Non-Goals

**Goals:** block DNS rebinding and cross-site writes without breaking the clients above; make a delivered draft durable before any IMAP work.

**Non-Goals:** authentication for the web interface; a configurable host allowlist; changing timeouts for synchronization or other IMAP operations (being reworked in PR #15); moving conversation recording (local SQLite, not a stall risk).

## Decisions

### Host check compares host names only, not ports

The allowlist is `127.0.0.1`, `localhost`, `[::1]` plus `POSTREEVE_HOST` unless it is a wildcard. The port is ignored. DNS rebinding is defeated by the name alone: the attacker's page can only produce a Host naming its own domain. Checking the port would add nothing against rebinding and would break the Vite proxy (Host carries the Vite port) and Compose with a remapped host port. Alternative considered: exact `host:port` match — rejected for those breakages.

### Configured non-loopback hosts are allowed by name

A user who sets `POSTREEVE_HOST=192.168.1.10` (or a hostname) has deliberately exposed the server; that name is allowed. With a wildcard bind outside Docker, only loopback names work; the user must name the address to reach it otherwise. No separate `POSTREEVE_ALLOWED_HOSTS` variable until someone needs it.

### Origin check: present `Origin` must equal `http://<Host>`; skipped with a desktop token

Browsers send `Origin` on cross-origin and same-origin non-GET fetches. Comparing with the request's own `Host` (already allowlisted) keeps the Vite proxy working, since it forwards both unchanged. Missing `Origin` (curl, scripts) is allowed; the Host check still applies. When `POSTREEVE_DESKTOP_TOKEN` is set, every API request except the GET OAuth callback already needs the token, which a foreign page cannot obtain, and the proxy's `Origin` is `postreeve://app`; so the Origin check is skipped there instead of whitelisting a custom-scheme origin. `GET`s are exempt: the API has no CORS headers, so cross-origin pages cannot read responses, and OAuth's callback is a top-level GET navigation.

Implemented as one middleware module `src/server/security/request-origin.ts` exporting `allowedHostGuard(configuredHost)` (on `*`) and `sameOriginGuard()` (on `/api/*`, installed only without a desktop token), placed before desktop authentication.

### Settle first, then save the Sent copy

`#dispatchMessageSend` stops saving the copy and returns `{ receipt, mime }`. `sendMessage` saves the copy after dispatch. `sendDraft` settles the draft as `sent`, then saves the copy, then (if the copy added a warning) stores the warned receipt with a new `Store.updateSentDraftReceipt`, which updates only `delivery_receipt` of a `sent` draft and does not bump the version (the draft is no longer editable, and clients deleting it already hold the version returned with it). A failure to store the warning is ignored beyond the response: the response still carries it. In the settlement-failure path the copy is still saved when recipients accepted, and its warning joins the response.

### Sent copy uses tighter imapflow timeouts

`ImapMailProvider.#withClient` gains optional connection timeouts; `appendSentMessage` passes `connectionTimeout: 30_000`, `greetingTimeout: 16_000` (imapflow default, stated explicitly) and `socketTimeout: 60_000`. Socket inactivity is the right bound for a stalled server; 60 s still tolerates slow APPENDs of large messages because data keeps flowing.

After `connect()` imapflow reports a socket timeout as an `error` event and closes the client, which rejects the in-flight command. No listener was attached, so that event would have thrown and crashed the server (reproduced against a stalling TCP server). The default client factory therefore attaches a no-op `error` listener; the operation still fails through its rejected command.

## Risks / Trade-offs

- [A client sends `Origin` for same-site use behind a reverse proxy that rewrites Host] → unsupported deployment model; AGENTS.md requires loopback.
- [A stored warning update can race a delete of the sent draft] → update matches `delivery_status = 'sent'`; zero rows is ignored.
- [60 s inactivity might cut a very slow server mid-APPEND] → the outcome is only a Sent-copy warning; delivery is unaffected.
