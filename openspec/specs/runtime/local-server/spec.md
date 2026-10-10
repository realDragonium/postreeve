# Local Server Specification

## Purpose
Covers the Postreeve server process: its environment configuration and defaults, loopback binding, security headers, serving the web bundle, the health endpoint, the shared API error format, startup, the optional desktop API token and the Docker Compose deployment. The Electron shell that launches the server as a sidecar is specified in runtime/desktop-app; the master key in accounts/credential-vault; Google settings in accounts/gmail-accounts; recovery of interrupted draft sends at startup in compose/drafts; upload and message size limits in compose/draft-files.

## Requirements

### Requirement: Environment configuration defaults
The server SHALL read its configuration from environment variables with these defaults: `POSTREEVE_HOST` `127.0.0.1`, `PORT` `3000`, `POSTREEVE_DB_PATH` `./data/postreeve.sqlite`, `POSTREEVE_MAX_ATTACHMENT_BYTES` 26214400, `POSTREEVE_MAX_UPLOAD_BYTES` 20971520 and `POSTREEVE_MAX_MESSAGE_BYTES` 26214400. It SHALL create the database file's parent directory when it does not exist.

#### Scenario: No configuration
- **WHEN** the server starts with none of these variables set
- **THEN** it listens on `127.0.0.1:3000` and stores data in `./data/postreeve.sqlite`

### Requirement: Invalid configuration stops startup
The server SHALL refuse to start unless the host is non-empty after trimming, the port is an integer from 1 to 65535 and each byte limit is a positive integer.

#### Scenario: Invalid port
- **WHEN** `PORT` is `70000`
- **THEN** the server exits during startup without listening

#### Scenario: Zero upload limit
- **WHEN** `POSTREEVE_MAX_UPLOAD_BYTES` is `0`
- **THEN** the server exits during startup without listening

### Requirement: The server binds to loopback by default
The server SHALL listen on `POSTREEVE_HOST`, which defaults to `127.0.0.1`, and SHALL log `Postreeve listening on http://<host>:<port>` once listening. Outside the desktop app the web interface and API have no authentication, so the default binding MUST remain loopback-only.

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
When `POSTREEVE_DESKTOP_TOKEN` is set to a non-blank value, the server SHALL require `Authorization: Bearer <token>` with exactly that token on every `/api/*` request except `GET /api/oauth/google/callback`, and SHALL answer any other request with 401 `{ error: "Unauthorized" }`. When it is unset or blank, the API SHALL require no token. When `POSTREEVE_DESKTOP_URL` is set, Google OAuth results SHALL redirect to that URL with the `google` and `accountId` query instead of to `/`.

#### Scenario: Missing token
- **WHEN** the server runs with a desktop token and a request to `/api/health` has no `Authorization` header
- **THEN** the response is 401

#### Scenario: Google callback without token
- **WHEN** Google redirects the browser to `/api/oauth/google/callback` on a server with a desktop token
- **THEN** the request is handled without a token and is protected by its OAuth `state`

### Requirement: Docker Compose publishes only on loopback
The Compose deployment SHALL build the server image, publish container port 3000 only on host address `127.0.0.1:3000`, pass `POSTREEVE_MASTER_KEY` from the host environment or `.env`, store the database at `/app/data/postreeve.sqlite` in the named volume `postreeve-data`, run the server as the unprivileged `bun` user and restart it unless stopped. Inside the container the server SHALL listen on `0.0.0.0` so the published port reaches it.

#### Scenario: Starting with Compose
- **WHEN** a user runs `docker compose up --build` after `bun run setup:local`
- **THEN** Postreeve is reachable at `http://127.0.0.1:3000` on the host and not on other host interfaces

#### Scenario: Recreating the container
- **WHEN** the container is removed and started again
- **THEN** accounts and history persist in the `postreeve-data` volume

### Requirement: Requests must name an allowed host
The server SHALL answer 403 `{ error: "Forbidden host" }` to any request whose `Host` header is missing or whose host name, ignoring case and port, is not `127.0.0.1`, `localhost`, `[::1]` or the configured `POSTREEVE_HOST`. A wildcard `POSTREEVE_HOST` (`0.0.0.0` or `::`) SHALL add no name, so only loopback names are accepted. This blocks DNS-rebinding pages from reaching the unauthenticated API.

#### Scenario: Browser on loopback
- **WHEN** a browser requests `http://127.0.0.1:3000/api/health`
- **THEN** the response is 200

#### Scenario: Rebound domain
- **WHEN** a request to the server carries `Host: attacker.example:3000`
- **THEN** the response is 403 and the request is not handled

#### Scenario: Docker Compose
- **WHEN** the server listens on `0.0.0.0` in its container and a browser on the host opens `http://127.0.0.1:3000`
- **THEN** the request is accepted

#### Scenario: Deliberately configured address
- **WHEN** `POSTREEVE_HOST` is `192.168.1.10` and a request carries `Host: 192.168.1.10:3000`
- **THEN** the request is accepted

### Requirement: Cross-site state changes are rejected
Unless a desktop token is configured, the server SHALL answer 403 `{ error: "Forbidden origin" }` to an `/api/*` request with a method other than `GET`, `HEAD` or `OPTIONS` whose `Origin` header is present and is not `http://<Host>` for the request's own `Host`. Requests without `Origin` SHALL be handled normally.

#### Scenario: Same-origin send
- **WHEN** the web interface at `http://127.0.0.1:3000` posts to `/api/messages/send`
- **THEN** the request is handled

#### Scenario: Cross-site form post
- **WHEN** a page at `http://localhost:8080` posts to `http://localhost:3000/api/messages/send`
- **THEN** the response is 403 and nothing is sent

#### Scenario: Desktop app
- **WHEN** the desktop protocol proxy forwards a `POST` with the launch token and `Origin: postreeve://app`
- **THEN** the request is handled
