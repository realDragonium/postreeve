# Proposal

## Why

Postreeve is moving from a loopback-only local app to a web app the owner deploys on Fly.io and uses daily. Today the web interface and API have no authentication: only the Electron sidecar is protected, by a per-launch bearer token, and the server refuses every host name except loopback ones. Exposed on the public internet, anyone could read and send the owner's mail.

## What Changes

- **Single owner.** The first visit to an instance without an owner shows a setup screen. Creating the owner requires a one-time setup token from `POSTREEVE_SETUP_TOKEN`, or one the server generates and logs at startup while no owner exists, so a stranger cannot claim a fresh public instance.
- **Passkeys first, password as fallback.** The owner signs in with a passkey (WebAuthn, via `@simplewebauthn/server` and `@simplewebauthn/browser`) or a password hashed with argon2id (`Bun.password`). Settings → Security lists, adds and removes passkeys, changes the password and lists sessions.
- **Sessions.** Random opaque session IDs, stored only as SHA-256 hashes in SQLite, in an `HttpOnly; SameSite=Lax` cookie that is `Secure` over https, with a 7-day idle and 30-day absolute expiry, logout, per-session revoke and "sign out other sessions". Failed sign-in and setup attempts are rate-limited.
- **Every `/api` route requires the owner**, including `GET /api/events` and attachment downloads, except `GET /api/health` and the public sign-in endpoints. Loopback requests need the session too, so there is one code path. The desktop app keeps its per-launch bearer token unchanged and needs no owner sign-in.
- **CSRF.** The existing cross-site write rejection now compares `Origin` with the request's real scheme and the public URL, and also rejects unsafe requests without `Origin` whose `Sec-Fetch-Site` is `cross-site` or `same-site`. It covers the sign-in endpoints.
- **Hosted mode.** `POSTREEVE_PUBLIC_URL` (for example `https://postreeve.fly.dev`) adds its host to the host check, is the WebAuthn origin and RP ID, and makes cookies `Secure`. `POSTREEVE_TRUST_PROXY=1` makes the server trust `Fly-Forwarded-Proto`/`X-Forwarded-Proto` and `Fly-Client-IP`/`X-Forwarded-For`.
- **Contract for other workstreams.** `src/server/security/owner-auth.ts` exports the Hono middleware `requireOwner` and `getOwnerSession(c)`.
- WebMCP tools run in the signed-in page and call the API with the page's session cookie; agents/webmcp-tools does not change.

## Capabilities

### New Capabilities

- `runtime/owner-auth`: Owner setup, passkey and password sign-in, sessions, rate limiting, the owner API guard and the Security settings.

### Modified Capabilities

- `runtime/local-server`: The "no authentication" binding statement, the allowed-host check (public URL), cross-site write rejection (scheme, public URL, `Sec-Fetch-Site`), the event stream's protection, and new environment variables.

## Impact

New dependencies `@simplewebauthn/server` and `@simplewebauthn/browser`. New SQLite tables `owner`, `owner_passkeys` and `owner_sessions`. Server composition moves into `src/server/app.ts` so tests exercise the real middleware order. Web: an auth gate with setup and sign-in screens, Security settings, and a 401 handler. README and the local-server spec drop the "no authentication" statements. Not touched: fly.toml, Dockerfile and `src/server/google/oauth.ts` (another workstream). Linear issue: none named for this run.
