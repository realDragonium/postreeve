# Design

## Context

The server composes its middleware in `src/server/index.ts`: secure headers, `allowedHostGuard` (loopback names plus `POSTREEVE_HOST`), `sameOriginGuard` (only without a desktop token) and `desktopApiAuthentication`. The web UI calls `/api` with same-origin `fetch` and an `EventSource` on `/api/events`; WebMCP tools in `src/web/webmcp.ts` go through the same `api` module. Tables are created by hand-written SQL at store startup; the newest module (`contacts/correspondents.ts`) owns its tables with `CREATE TABLE IF NOT EXISTS`.

## Goals / Non-Goals

Goals: one owner, safe on the public internet, passkeys first, one code path on loopback and hosted, desktop app unchanged, a small contract (`requireOwner`, `getOwnerSession`) for the remote MCP workstream.

Non-goals: multiple users, account recovery without server access, deployment files (fly.toml, Dockerfile) and the hosted Google OAuth redirect, which belong to another workstream.

## Decisions

### Auth is required on loopback too
One code path is simpler to reason about and test, and a loopback server reached through a browser is still exposed to DNS rebinding and other local users. The desktop sidecar stays on its bearer token: when `POSTREEVE_DESKTOP_TOKEN` is set, the owner guard is not mounted and `getOwnerSession` returns a `desktop` session for a request carrying the token, so `/api/auth/session` tells the renderer it is signed in. Alternative considered: skip auth on loopback; rejected because it doubles the paths and leaves a local server open to other users of the machine.

### Composition lives in `src/server/app.ts`
`createServerApp({ service, store, ... })` builds the Hono app with the exact middleware order. `index.ts` only reads config and listens. Contract tests and the e2e fixture use the same function, so tests cannot drift from production.

### Storage
Three tables owned by `src/server/security/owner-store.ts`, created with `CREATE TABLE IF NOT EXISTS` like `correspondents` (no version number, so parallel workstreams adding numbered migrations cannot collide). Drizzle definitions are added to `schema.ts` and the store uses Drizzle's synchronous bun-sqlite API.
- `owner`: single row (`id = 1` check), argon2id `password_hash`, random `webauthn_user_id`, timestamps.
- `owner_passkeys`: credential ID (base64url), public key, counter, transports, device type, backed-up flag, name, created/last-used.
- `owner_sessions`: public random `id`, `token_hash` (SHA-256 of the cookie value, unique), method, user agent, created, last seen, absolute expiry.
Only the hash of a session token is stored, so a leaked database file does not yield live sessions.

### Sessions
32 random bytes, base64url, in cookie `__Host-postreeve-session` when the request is secure, otherwise `postreeve-session` (the `__Host-` prefix requires `Secure`). `HttpOnly; Path=/; SameSite=Lax`. Idle timeout 7 days, absolute 30 days: daily use rarely re-prompts, and a stolen cookie dies within a week of disuse. `last_seen_at` is written at most once a minute. Changing the password signs out every other session. Expired rows are deleted on lookup and at most hourly in bulk.

A request is secure when its scheme is https (from the socket, or from `Fly-Forwarded-Proto`/`X-Forwarded-Proto` when `POSTREEVE_TRUST_PROXY` is `1` or `true`), or when it targets the `POSTREEVE_PUBLIC_URL` host and that URL is https. The second rule keeps cookies Secure on Fly even without trusting the proxy, since the browser's connection is https.

### Setup token
`POSTREEVE_SETUP_TOKEN` (at least 16 characters, else startup fails) or, while no owner exists, 24 random bytes generated per process and logged once at startup. It is never logged when it comes from the environment. Comparison uses SHA-256 digests and `timingSafeEqual`. Once an owner exists, setup answers 409. Setup requires a password (12 to 256 characters) so there is always a fallback; passkeys are offered right after.

### WebAuthn
RP ID and expected origin are per request: the public URL's host name and origin when the request targets that host; `localhost` and the request's own origin for `localhost`; otherwise passkeys are unavailable (IP addresses are not valid RP IDs and other names over http are not secure contexts), and the UI says so. Challenges are kept in memory for 5 minutes, single use, capped at 100 (oldest dropped) so unauthenticated option requests cannot grow memory. Postreeve runs as one process on one SQLite file, so in-memory state is sufficient. `residentKey: preferred`, `userVerification: preferred`; sign-in sends `allowCredentials` for the owner's passkeys so non-discoverable keys work too. Credential IDs reveal nothing useful. The counter is updated on each use.

### Rate limiting
In memory, per client key (`Fly-Client-IP`, else the first `X-Forwarded-For` entry when the proxy is trusted, else the socket address): 5 failures in 15 minutes blocks further attempts from that key with 429 and `Retry-After`. A global cap of 50 password or setup-token failures per 15 minutes stops distributed guessing; passkey sign-in is not subject to the global cap, so an attacker cannot lock the owner out of passkeys. Success clears the client's count.

### CSRF
`sameOriginGuard` now takes the auth configuration: for unsafe methods, `Origin`, when present, must equal the request's own origin (real scheme + Host) or the public URL's origin when the request targets that host. Without `Origin`, `Sec-Fetch-Site: cross-site` or `same-site` is rejected. `SameSite=Lax` already withholds the cookie from cross-site subrequests; the origin check also covers sibling subdomains (same-site) on custom domains and login CSRF. The desktop path keeps no origin guard, as before.

### API guard and errors
`requireOwner` answers 401 `{ error: "Authentication required", code: "unauthenticated" }`. The `/api/*` guard exempts `GET /api/health`, `GET /api/auth/session`, `POST /api/auth/setup`, `POST /api/auth/login/*` and `POST /api/auth/logout`. The Google OAuth callback is not exempt: it is a top-level GET navigation, so the `Lax` cookie arrives with it. The web client dispatches a `postreeve:unauthenticated` event on that code and the auth gate returns to the sign-in screen.

### Event streams end with their session
Authentication runs when a request starts, so an open `/api/events` stream would outlive a revoked session. The stream rechecks its session (without extending it) on every 15-second keep-alive and closes when the session is gone; the client's next reconnect then gets 401 and the page shows sign-in.

### Contract
```ts
// src/server/security/owner-auth.ts
export const requireOwner: MiddlewareHandler;           // 401 unless an owner session
export function getOwnerSession(c: Context): OwnerSession | null;
export interface OwnerSession { id: string; method: "password" | "passkey" | "desktop"; createdAt: string; lastSeenAt: string; expiresAt: string; }
```
Both read the `OwnerAuth` instance placed on the context by `ownerAuthContext(auth)`, mounted on `*`, so they also work on non-`/api` routes such as a future OAuth consent page. The lookup is cached per request.

### Web UI
`AuthGate` in `main.tsx` queries `/api/auth/session` and renders the setup screen, sign-in screen or `App`. Settings gains a **Security** section (passkeys, password, sessions, sign out), reachable even before an account is connected. Desktop sessions hide it.

## Risks / Trade-offs

- Lost password and passkeys lock the owner out. Recovery is deleting the `owner` row on the server, which re-enables setup with a new token; README documents it. Accepted for a single-owner self-hosted app.
- In-memory rate limits and challenges reset on restart. Accepted: a restart costs an attacker more than it gains.
- `@simplewebauthn/server` pulls several `@peculiar/asn1-*` packages; mixed `asn1-schema` copies break its schema registry at import time, so `package.json` overrides `@peculiar/asn1-schema` to one version.
- The web bundle grows by about 24 kB and crosses Vite's 500 kB warning; it stays a warning.
- Mocked e2e specs stub `/api/auth/session` in the page; one new e2e spec drives the real server through setup, password sign-in, a virtual-authenticator passkey, sign-out and passkey sign-in.
