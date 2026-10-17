## ADDED Requirements

### Requirement: An instance without an owner offers setup
While no owner exists, `GET /api/auth/session` SHALL answer `{ state: "setup" }` and the web interface SHALL show a setup screen that asks for the setup token and a password.

#### Scenario: Fresh instance
- **WHEN** a browser opens a Postreeve instance that has no owner
- **THEN** it shows the setup screen

### Requirement: Owner setup requires the setup token
`POST /api/auth/setup` with `{ setupToken, password }` SHALL create the owner and sign them in only when the token equals `POSTREEVE_SETUP_TOKEN`, or, when that is unset, the token the server generated and logged at startup. It SHALL answer a wrong token with 403, a password shorter than 12 or longer than 256 characters with 400, and any request after an owner exists with 409. The server SHALL NOT log a token taken from the environment.

#### Scenario: Stranger on a fresh instance
- **WHEN** a request to a fresh instance posts setup with a guessed token
- **THEN** the response is 403 and no owner exists

#### Scenario: Owner claims the instance
- **WHEN** the owner posts setup with the logged token and a 16-character password
- **THEN** the response sets a session cookie and `GET /api/auth/session` answers `authenticated`

#### Scenario: Second setup
- **WHEN** setup is posted again after an owner exists, even with the right token
- **THEN** the response is 409

### Requirement: Password sign-in
`POST /api/auth/login/password` with `{ password }` SHALL verify the password against its argon2id hash and, on success, create a session. A wrong password or a missing owner SHALL answer 401 `{ error: "Incorrect password" }`. Passwords SHALL be stored only as argon2id hashes.

#### Scenario: Correct password
- **WHEN** the owner signs in with the right password
- **THEN** the response sets the session cookie and API requests with it succeed

#### Scenario: Wrong password
- **WHEN** a client signs in with a wrong password
- **THEN** the response is 401 and no cookie is set

### Requirement: Passkey sign-in
`POST /api/auth/login/passkey/options` SHALL return WebAuthn authentication options listing the owner's passkeys, and `POST /api/auth/login/passkey/verify` SHALL create a session for a valid assertion from a stored passkey and update its counter and last-used time. Each challenge SHALL expire after 5 minutes and be accepted once.

#### Scenario: Sign in with a passkey
- **WHEN** the owner signs in with a registered passkey
- **THEN** a session is created and the passkey's last-used time updates

#### Scenario: Replayed challenge
- **WHEN** a passkey response is verified a second time
- **THEN** the second verification answers 401

### Requirement: Passkey origin and relying party
The WebAuthn RP ID and expected origin SHALL be the `POSTREEVE_PUBLIC_URL` host name and origin for requests to that host, and `localhost` with the request's own origin for requests to `localhost`. For any other host, passkey endpoints SHALL answer 400 and `GET /api/auth/session` SHALL report `passkeys: false`.

#### Scenario: Hosted passkey
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://postreeve.fly.dev` and the owner registers a passkey there
- **THEN** the passkey's RP ID is `postreeve.fly.dev`

#### Scenario: Passkeys on an IP address
- **WHEN** the owner opens `http://127.0.0.1:3000`
- **THEN** the sign-in screen offers only the password and says passkeys need `localhost` or the public URL

### Requirement: Passkey management
The signed-in owner SHALL list passkeys at `GET /api/auth/passkeys`, register one with `POST /api/auth/passkeys/options` followed by `POST /api/auth/passkeys` with `{ name, response }`, and remove one with `DELETE /api/auth/passkeys/<id>`. The password always remains as a fallback, so removing the last passkey SHALL be allowed.

#### Scenario: Removing a lost passkey
- **WHEN** the owner removes a passkey in Settings
- **THEN** that passkey can no longer sign in

### Requirement: Password change
`POST /api/auth/password` with `{ currentPassword, newPassword }` SHALL replace the password hash when the current password is correct and the new one is 12 to 256 characters, and SHALL end every other session. A wrong current password SHALL answer 401.

#### Scenario: Changing the password
- **WHEN** the owner changes the password from one browser while signed in on two
- **THEN** the old password no longer signs in and the other browser's session is ended

### Requirement: Session cookie
A session SHALL be a random 32-byte token in an `HttpOnly; Path=/; SameSite=Lax` cookie, named `__Host-postreeve-session` with `Secure` when the request is secure and `postreeve-session` otherwise. The server SHALL store only the token's SHA-256 hash. A request is secure when its scheme is https, using forwarded-scheme headers only when `POSTREEVE_TRUST_PROXY` is `1` or `true`, or when it targets the host of an https `POSTREEVE_PUBLIC_URL`.

#### Scenario: Hosted cookie
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://postreeve.fly.dev` and the owner signs in there
- **THEN** the cookie is `__Host-postreeve-session` with `Secure`

#### Scenario: Forged forwarded scheme
- **WHEN** `POSTREEVE_TRUST_PROXY` is unset and a loopback request sends `X-Forwarded-Proto: https`
- **THEN** the cookie is `postreeve-session` without `Secure`

### Requirement: Session expiry and sign-out
A session SHALL end 7 days after its last use or 30 days after creation, whichever comes first. `POST /api/auth/logout` SHALL end the current session and clear the cookie.

#### Scenario: Idle expiry
- **WHEN** a session is not used for 7 days
- **THEN** the next API request with its cookie answers 401

#### Scenario: Absolute expiry
- **WHEN** a session used every day reaches 30 days of age
- **THEN** it no longer authorizes requests

#### Scenario: Sign out
- **WHEN** the owner signs out
- **THEN** the cookie is cleared and the old token no longer authorizes requests

### Requirement: Session management
The signed-in owner SHALL list sessions, with the current one marked, at `GET /api/auth/sessions`, end one with `DELETE /api/auth/sessions/<id>`, and end all others with `POST /api/auth/sessions/revoke-others`.

#### Scenario: Sign out other sessions
- **WHEN** the owner chooses **Sign out other sessions**
- **THEN** every session except the current one stops authorizing requests

### Requirement: Sign-in attempts are rate-limited per client
The server SHALL count failed setup, password and passkey attempts per client, identified by `Fly-Client-IP` or the first `X-Forwarded-For` address when the proxy is trusted and by the connection's address otherwise. After 5 failures within 15 minutes it SHALL answer that client's attempts with 429 and `Retry-After` until the window passes. A successful sign-in SHALL clear the client's count.

#### Scenario: Password guessing
- **WHEN** one client fails password sign-in 5 times in a minute
- **THEN** its sixth attempt answers 429, even with the right password

### Requirement: Distributed guessing is capped
After 50 failed setup or password attempts across all clients within 15 minutes, the server SHALL answer further setup and password attempts with 429 until the window passes. Passkey sign-in SHALL remain available.

#### Scenario: Many addresses guessing
- **WHEN** 50 password failures arrive from different addresses within 15 minutes
- **THEN** password sign-in answers 429 and passkey sign-in still works

### Requirement: The API requires the owner
Unless a desktop token is configured, every `/api/*` request SHALL require a valid owner session and otherwise answer 401 `{ error: "Authentication required", code: "unauthenticated" }`, except `GET /api/health`, `GET /api/auth/session`, `POST /api/auth/setup`, `POST /api/auth/login/*` and `POST /api/auth/logout`. This includes `GET /api/events`, attachment downloads and the Google OAuth start and callback.

#### Scenario: Unauthenticated read
- **WHEN** a client without a session requests `GET /api/accounts`
- **THEN** the response is 401 with code `unauthenticated`

#### Scenario: Event stream without a session
- **WHEN** a client without a session opens `GET /api/events`
- **THEN** the response is 401 and no stream opens

#### Scenario: WebMCP tool in the signed-in page
- **WHEN** an agent calls a WebMCP tool in the page where the owner is signed in
- **THEN** the tool's API calls carry the session cookie and succeed

### Requirement: Owner check for other server routes
`src/server/security/owner-auth.ts` SHALL export the Hono middleware `requireOwner`, which answers 401 like the API guard unless the request has an owner session, and `getOwnerSession(c)`, which returns the current session or `null`. Both SHALL work on routes outside `/api`.

#### Scenario: Consent page
- **WHEN** a route outside `/api` uses `requireOwner` and a request without a session reaches it
- **THEN** the response is 401

### Requirement: Desktop app sessions
With a desktop token configured, `getOwnerSession` SHALL return a session with method `desktop` for a request carrying the token, and `GET /api/auth/session` SHALL answer `authenticated` with `desktop: true`, so the desktop app needs no owner sign-in.

#### Scenario: Desktop app
- **WHEN** the desktop app opens
- **THEN** it shows the mailbox without a sign-in screen and Settings has no Security section

### Requirement: Sign-in screens in the web interface
The web interface SHALL show the setup screen, the sign-in screen or the application according to `GET /api/auth/session`, and SHALL return to the sign-in screen when an API call answers code `unauthenticated`. The sign-in screen SHALL offer **Sign in with a passkey** when passkeys are available, and a password form. After setup it SHALL offer to add a passkey.

#### Scenario: Session ends while the app is open
- **WHEN** the owner's session is revoked from another browser and the app makes its next API call
- **THEN** the app shows the sign-in screen

### Requirement: Security settings
Settings SHALL have a **Security** section, reachable before any account is connected, that lists passkeys with add and remove, changes the password, lists sessions with the current one marked, ends one or all other sessions, and signs out.

#### Scenario: Adding a passkey later
- **WHEN** the owner opens Settings → Security and chooses **Add passkey**
- **THEN** the browser's passkey prompt appears and the new passkey is listed afterwards
