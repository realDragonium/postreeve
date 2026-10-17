## MODIFIED Requirements

### Requirement: Passkey origin and relying party
The WebAuthn RP ID and expected origin SHALL be the `POSTREEVE_PUBLIC_URL` host name and origin for requests to that host, and `localhost` with the request's own origin for requests to `localhost`, where the host is the trusted `X-Forwarded-Host` or else `Host`. For any other host, passkey endpoints SHALL answer 400 and `GET /api/auth/session` SHALL report `passkeys: false`.

#### Scenario: Hosted passkey
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://box.tail1234.ts.net` and the owner registers a passkey there through `tailscale serve`
- **THEN** the passkey's RP ID is `box.tail1234.ts.net`

#### Scenario: Passkeys on an IP address
- **WHEN** the owner opens `http://127.0.0.1:3000`
- **THEN** the sign-in screen offers only the password and says passkeys need `localhost` or the public URL

### Requirement: Session cookie
A session SHALL be a random 32-byte token in an `HttpOnly; Path=/; SameSite=Lax` cookie, named `__Host-postreeve-session` with `Secure` when the request is secure and `postreeve-session` otherwise. The server SHALL store only the token's SHA-256 hash. A request is secure when its scheme is https, using `X-Forwarded-Proto` only when `POSTREEVE_TRUST_PROXY` is `1` or `true`, or when it targets the host of an https `POSTREEVE_PUBLIC_URL`.

#### Scenario: Hosted cookie
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://box.tail1234.ts.net` and the owner signs in there
- **THEN** the cookie is `__Host-postreeve-session` with `Secure`

#### Scenario: Forged forwarded scheme
- **WHEN** `POSTREEVE_TRUST_PROXY` is unset and a loopback request sends `X-Forwarded-Proto: https`
- **THEN** the cookie is `postreeve-session` without `Secure`

### Requirement: Sign-in attempts are rate-limited per client
The server SHALL count failed setup, password and passkey attempts per client, identified by the rightmost `X-Forwarded-For` address when the proxy is trusted and by the connection's address otherwise. After 5 failures within 15 minutes it SHALL answer that client's attempts with 429 and `Retry-After` until the window passes. A successful sign-in SHALL clear the client's count.

#### Scenario: Password guessing
- **WHEN** one client fails password sign-in 5 times in a minute
- **THEN** its sixth attempt answers 429, even with the right password

#### Scenario: Client-supplied forwarding entries
- **WHEN** a client behind the trusted proxy varies the leftmost `X-Forwarded-For` entries across failed attempts
- **THEN** its attempts still count against the address the proxy appended

## ADDED Requirements

### Requirement: Proxy identity headers are not authentication
The server SHALL NOT authenticate a request by `Tailscale-User-Login`, `Tailscale-User-Name` or any other proxy identity header; only an owner session or the desktop token SHALL authorize API requests.

#### Scenario: Forged Tailscale login
- **WHEN** a request without a session sends `Tailscale-User-Login: owner@example.test` to `/api/accounts`
- **THEN** the response is 401
