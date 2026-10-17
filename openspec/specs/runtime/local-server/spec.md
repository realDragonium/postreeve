# Local Server Specification

## Purpose
Covers the Postreeve server process: its environment configuration and defaults, loopback binding, allowed hosts and cross-site write rejection, security headers, serving the web bundle, the health endpoint, the shared API error format, startup, the optional desktop API token, graceful shutdown, the container image and the Docker Compose deployment. Backups, the systemd service, the tailnet serving model and the public agent listener are specified in runtime/self-hosting. Owner sign-in and sessions are specified in runtime/owner-auth; the Electron shell that launches the server as a sidecar in runtime/desktop-app; the master key in accounts/credential-vault; Google settings in accounts/gmail-accounts; recovery of interrupted draft sends at startup in compose/drafts; upload and message size limits in compose/draft-files.

## Requirements

### Requirement: Environment configuration defaults
The server SHALL read its configuration from environment variables with these defaults: `POSTREEVE_HOST` `127.0.0.1`, `PORT` `3000`, `POSTREEVE_DB_PATH` `./data/postreeve.sqlite`, `POSTREEVE_MAX_ATTACHMENT_BYTES` 26214400, `POSTREEVE_MAX_UPLOAD_BYTES` 20971520 and `POSTREEVE_MAX_MESSAGE_BYTES` 26214400. `POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY` and `POSTREEVE_SETUP_TOKEN` are unset by default. It SHALL create the database file's parent directory when it does not exist.

#### Scenario: No configuration
- **WHEN** the server starts with none of these variables set
- **THEN** it listens on `127.0.0.1:3000`, stores data in `./data/postreeve.sqlite` and trusts no proxy headers

### Requirement: Invalid configuration stops startup
The server SHALL refuse to start unless the host is non-empty after trimming, the port is an integer from 1 to 65535, each byte limit is a positive integer, `POSTREEVE_PUBLIC_URL`, when set, is an `http` or `https` URL without path, query or fragment, and `POSTREEVE_SETUP_TOKEN`, when set, has at least 16 characters.

#### Scenario: Invalid port
- **WHEN** `PORT` is `70000`
- **THEN** the server exits during startup without listening

#### Scenario: Zero upload limit
- **WHEN** `POSTREEVE_MAX_UPLOAD_BYTES` is `0`
- **THEN** the server exits during startup without listening

#### Scenario: Public URL with a path
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://example.test/mail`
- **THEN** the server exits during startup without listening

### Requirement: The server binds to loopback by default
The server SHALL listen on `POSTREEVE_HOST`, which defaults to `127.0.0.1`, and SHALL log `Postreeve listening on http://<host>:<port>` once listening. The web interface and API require the owner's sign-in (runtime/owner-auth); a deployment reachable from other machines SHALL set `POSTREEVE_PUBLIC_URL` and serve it over https.

#### Scenario: Default start
- **WHEN** a user runs `bun run start` with the `.env` from `bun run setup:local`
- **THEN** Postreeve is reachable at `http://127.0.0.1:3000` and not on other network interfaces

### Requirement: Health endpoint
The server SHALL answer `GET /api/health` with 200 `{ ok: true }` once it is serving requests.

#### Scenario: Readiness check
- **WHEN** a client requests `GET /api/health` on a started server
- **THEN** the response is 200 with `{ "ok": true }`

### Requirement: Content Security Policy on every response
The server SHALL send on every response the Content-Security-Policy `default-src 'self'; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'`. Remote images SHALL be allowed by this policy so that the reader's own image consent decides whether they load.

#### Scenario: API response policy
- **WHEN** a client requests `GET /api/health`
- **THEN** the response's Content-Security-Policy contains `script-src 'self'` and `img-src 'self' data: blob: http: https:`

### Requirement: Additional security headers on every response
The server SHALL send on every response `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`.

#### Scenario: Page response headers
- **WHEN** a browser loads `/`
- **THEN** the response carries `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`

### Requirement: The server serves the built web interface
The server SHALL serve files from the production bundle in `./dist` and SHALL answer a `GET` for a non-API path that matches no file with `dist/index.html`, so client-side routes load the application.

#### Scenario: Opening the application
- **WHEN** a browser requests `/`
- **THEN** the server returns the web interface's `index.html`

#### Scenario: Static asset
- **WHEN** the browser requests a bundled script under `/assets/`
- **THEN** the file is returned with a JavaScript content type

### Requirement: API errors use one JSON shape
The API SHALL answer a failed request with a JSON body `{ error }` and status 400, except for typed failures, which SHALL also carry `code`: `account_conflict` with 409, `draft_not_found` with 404, `draft_deleted` with 410 and `draft_conflict` with 409. Request bodies, parameters and queries that fail schema validation SHALL be answered with 400.

#### Scenario: Ordinary failure
- **WHEN** an API call fails with an untyped error such as an unknown account
- **THEN** the response is 400 with `{ "error": "Account not found" }`

#### Scenario: Typed failure
- **WHEN** account removal conflicts with an active draft delivery
- **THEN** the response is 409 with `code` `account_conflict`

### Requirement: Startup loads stored accounts before serving
The server SHALL open the database, migrate it, decrypt the credentials of every stored account and register its mail connection before it starts listening. If any stored account cannot be loaded, the server SHALL fail to start rather than serve without it.

#### Scenario: Restart with stored accounts
- **WHEN** the server restarts with two stored accounts and the correct key
- **THEN** both accounts are usable as soon as the server is listening, without reconnecting

### Requirement: Optional bearer token for the desktop sidecar
When `POSTREEVE_DESKTOP_TOKEN` is set to a non-blank value, the server SHALL require `Authorization: Bearer <token>` with exactly that token on every `/api/*` request except `GET /api/oauth/google/callback`, SHALL answer any other request with 401 `{ error: "Unauthorized" }`, and SHALL NOT require an owner session. When it is unset or blank, the API SHALL require the owner's session instead (runtime/owner-auth).

#### Scenario: Missing token
- **WHEN** the server runs with a desktop token and a request to `/api/health` has no `Authorization` header
- **THEN** the response is 401

#### Scenario: Google callback without token
- **WHEN** Google redirects the browser to `/api/oauth/google/callback` on a server with a desktop token
- **THEN** the request is handled without a token and is protected by its OAuth `state`

#### Scenario: Desktop token without owner
- **WHEN** the server runs with a desktop token, no owner exists, and the desktop app requests `/api/accounts` with the token
- **THEN** the request is handled

### Requirement: Google OAuth results return to the desktop URL
When `POSTREEVE_DESKTOP_URL` is set, Google OAuth results SHALL redirect to that URL with the `google` and `accountId` query instead of to `/`.

#### Scenario: Desktop Google connection
- **WHEN** `POSTREEVE_DESKTOP_URL` is `postreeve://app/` and a Google connection succeeds
- **THEN** the callback redirects to `postreeve://app/?google=connected&accountId=<id>`

### Requirement: Docker Compose publishes only on loopback
The Compose deployment SHALL build the server image, publish container port 3000 only on host address `127.0.0.1` (port `POSTREEVE_HOST_PORT`, default 3000), refuse to start without `POSTREEVE_MASTER_KEY` from the host environment or `.env`, store the database at `/app/data/postreeve.sqlite` in the named volume `postreeve-data`, restart it unless stopped and allow 30 seconds for it to stop. Inside the container the server SHALL listen on `0.0.0.0` so the published port reaches it.

#### Scenario: Starting with Compose
- **WHEN** a user runs `docker compose up --build` after `bun run setup:local`
- **THEN** Postreeve is reachable at `http://127.0.0.1:3000` on the host and not on other host interfaces, and the container reports healthy

#### Scenario: Recreating the container
- **WHEN** the container is removed and started again
- **THEN** accounts and history persist in the `postreeve-data` volume

### Requirement: Compose passes hosted settings and keeps backups
The Compose deployment SHALL pass `POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY`, `POSTREEVE_SETUP_TOKEN`, the Google settings and the backup interval and count from the host environment or `.env`, and SHALL write snapshots to `/app/backups`, mounted from `POSTREEVE_BACKUP_HOST_DIR` (default `./backups`).

#### Scenario: Snapshots on the host
- **WHEN** the Compose service has run for a day
- **THEN** `./backups` on the host holds a `postreeve-*.sqlite` snapshot

### Requirement: The container image runs unprivileged
The container SHALL start as root only to give the `bun` user ownership of the data and backup directories and SHALL then run the server as the unprivileged `bun` user. The image SHALL report health by requesting `/api/health` on loopback and SHALL NOT contain `.env`, database or backup files.

#### Scenario: Root-owned bind mount
- **WHEN** the backup directory on the host was created by root
- **THEN** the container hands it to `bun` before starting and the server process runs with uid 1000

### Requirement: Requests must name an allowed host
The allowed host names are `127.0.0.1`, `localhost`, `[::1]`, a non-wildcard `POSTREEVE_HOST` and the `POSTREEVE_PUBLIC_URL` host; `0.0.0.0` and `::` add none. The server SHALL answer 403 `{ error: "Forbidden host" }` when `Host` is missing or not allowed, ignoring case and port, or when the proxy is trusted and the rightmost `X-Forwarded-Host` is not allowed. This blocks DNS-rebinding pages from reaching the API.

#### Scenario: Browser on loopback
- **WHEN** a browser requests `http://127.0.0.1:3000/api/health`
- **THEN** the response is 200

#### Scenario: Rebound domain
- **WHEN** a request to the server carries `Host: attacker.example:3000`
- **THEN** the response is 403 and the request is not handled

#### Scenario: Rebound domain with a forged forwarded host
- **WHEN** the proxy is trusted and a request carries `Host: attacker.example` and `X-Forwarded-Host: box.tail1234.ts.net`
- **THEN** the response is 403

#### Scenario: Docker Compose
- **WHEN** the server listens on `0.0.0.0` in its container and a browser on the host opens `http://127.0.0.1:3000`
- **THEN** the request is accepted

#### Scenario: Deliberately configured address
- **WHEN** `POSTREEVE_HOST` is `192.168.1.10` and a request carries `Host: 192.168.1.10:3000`
- **THEN** the request is accepted

#### Scenario: Hosted public URL
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://box.tail1234.ts.net` and `tailscale serve` forwards a request with `Host: box.tail1234.ts.net`
- **THEN** the request is accepted

### Requirement: Cross-site state changes are rejected
Unless a desktop token is configured, the server SHALL answer 403 `{ error: "Forbidden origin" }` to an `/api/*` write (any method but `GET`, `HEAD`, `OPTIONS`) whose `Origin` is present and is neither `<scheme>://<host>` of the request nor, for the `POSTREEVE_PUBLIC_URL` host, that URL's origin. Scheme and host SHALL come from the rightmost `X-Forwarded-Proto` and `X-Forwarded-Host` when `POSTREEVE_TRUST_PROXY` is `1` or `true` and they are present, else from the connection and `Host`.

#### Scenario: Same-origin send
- **WHEN** the web interface at `http://127.0.0.1:3000` posts to `/api/messages/send`
- **THEN** the request is handled

#### Scenario: Cross-site form post
- **WHEN** a page at `http://localhost:8080` posts to `http://localhost:3000/api/messages/send`
- **THEN** the response is 403 and nothing is sent

#### Scenario: Hosted origin behind a proxy
- **WHEN** the proxy is trusted and the page at `https://box.tail1234.ts.net` posts through `tailscale serve` over plain http to `127.0.0.1:3000`
- **THEN** the request is handled

#### Scenario: Desktop app
- **WHEN** the desktop protocol proxy forwards a `POST` with the launch token and `Origin: postreeve://app`
- **THEN** the request is handled

### Requirement: Origin-less cross-site writes are rejected
Unless a desktop token is configured, the server SHALL answer 403 `{ error: "Forbidden origin" }` to an `/api/*` request with a method other than `GET`, `HEAD` or `OPTIONS` that has no `Origin` header and whose `Sec-Fetch-Site` is `cross-site` or `same-site`. Requests without either header SHALL be handled normally, so session cookies, which are `SameSite=Lax`, alone never authorize a cross-site write from a browser.

#### Scenario: Sibling subdomain without Origin
- **WHEN** a request without `Origin` posts to `/api/auth/login/password` with `Sec-Fetch-Site: same-site`
- **THEN** the response is 403

#### Scenario: Command-line client
- **WHEN** a script posts to `/api/auth/login/password` without `Origin` or `Sec-Fetch-Site`
- **THEN** the request is handled

### Requirement: Event stream endpoint
`GET /api/events` SHALL answer `text/event-stream` and stay open until the client disconnects. It SHALL require the owner's session, or the bearer token when a desktop token is configured, like other API routes, SHALL close an open stream once its session has ended, and SHALL send a keep-alive often enough that idle-connection timeouts do not close it.

#### Scenario: Token required
- **WHEN** the server runs with a desktop token and `/api/events` is requested without it
- **THEN** the response is 401

#### Scenario: Session required
- **WHEN** the server runs without a desktop token and `/api/events` is requested without an owner session
- **THEN** the response is 401

#### Scenario: Session revoked while streaming
- **WHEN** the owner signs out the session an open event stream was opened with
- **THEN** the server closes that stream within one keep-alive interval

#### Scenario: Idle stream
- **WHEN** no mailbox changes occur for a minute
- **THEN** the stream stays open and the client receives keep-alives

### Requirement: Graceful shutdown
On SIGTERM or SIGINT the server SHALL stop accepting connections, end open `/api/events` streams, wait for in-flight requests and the running synchronization pass, close IMAP IDLE connections, then close the database and exit with status 0. If requests or synchronization have not finished after `POSTREEVE_SHUTDOWN_TIMEOUT_MS` (default 20000, at most 300000) it SHALL close the remaining connections before closing the database. A second signal during shutdown SHALL NOT start a second shutdown.

#### Scenario: Stop with an open event stream
- **WHEN** a browser holds `/api/events` open and the server receives SIGTERM
- **THEN** the stream ends, the server logs `Postreeve is shutting down` and `Postreeve stopped`, and exits without waiting for the timeout

#### Scenario: Send in flight
- **WHEN** SIGTERM arrives while a send request is being processed
- **THEN** the request completes and its response is delivered before the database closes

#### Scenario: Stuck request
- **WHEN** a request is still running after the shutdown timeout
- **THEN** its connection is closed and the database is closed
