# Tasks

## 1. Server foundation

- [x] 1.1 Add `@simplewebauthn/server` and `@simplewebauthn/browser`; add Drizzle tables `owner`, `owner_passkeys`, `owner_sessions` and `OwnerStore` with `CREATE TABLE IF NOT EXISTS` migration, wired into `Store`
- [x] 1.2 Add auth config parsing (`POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY`, `POSTREEVE_SETUP_TOKEN`) and request helpers (scheme, secure, client key, RP)
- [x] 1.3 Implement `OwnerAuth`: setup token, password hashing, sessions with idle and absolute expiry, rate limiter, WebAuthn challenges, registration and authentication
- [x] 1.4 Export `ownerAuthContext`, `requireOwner`, `getOwnerSession` and the `/api/*` guard from `src/server/security/owner-auth.ts`; add `/api/auth/*` routes

## 2. Server composition and request guards

- [x] 2.1 Extend `allowedHostGuard` with the public URL host and `sameOriginGuard` with real scheme, public origin and `Sec-Fetch-Site`
- [x] 2.2 Move app composition into `src/server/app.ts`; keep the desktop path unchanged; log the generated setup token at startup

## 3. Web interface

- [x] 3.1 Add the auth API client, a 401 `unauthenticated` event and `AuthGate` with setup and sign-in screens
- [x] 3.2 Add Settings → Security (passkeys, password, sessions, sign out), reachable without accounts and hidden on desktop

## 4. Verification and docs

- [x] 4.1 Unit and contract tests: setup token, password login, session expiry, CSRF rejection, unauthenticated 401, desktop token, rate limiting, host guard
- [x] 4.2 Stub the owner session in mocked e2e specs; add a real-server e2e spec with setup, password, virtual-authenticator passkey, sign-out, revocation and a WebMCP tool call; run Playwright (25 passed; `identities.spec.ts` is flaky on the base commit too)
- [x] 4.3 Update README and `.env` setup notes; run `bun run verify` and `bunx openspec validate --specs --strict`
- [x] 4.4 Close open `/api/events` streams when their session is revoked or expires (found by the revocation e2e): the stream rechecks its session on every keep-alive
