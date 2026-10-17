## MODIFIED Requirements

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

### Requirement: Requests must name an allowed host
The server SHALL answer 403 `{ error: "Forbidden host" }` to any request whose `Host` header is missing or whose host name, ignoring case and port, is not `127.0.0.1`, `localhost`, `[::1]`, the configured `POSTREEVE_HOST` or the host name of `POSTREEVE_PUBLIC_URL`. A wildcard `POSTREEVE_HOST` (`0.0.0.0` or `::`) SHALL add no name. This blocks DNS-rebinding pages from reaching the API.

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

#### Scenario: Hosted public URL
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://postreeve.fly.dev`, the server listens on `0.0.0.0` and a request carries `Host: postreeve.fly.dev`
- **THEN** the request is accepted

### Requirement: Cross-site state changes are rejected
Unless a desktop token is configured, the server SHALL answer 403 `{ error: "Forbidden origin" }` to an `/api/*` request with a method other than `GET`, `HEAD` or `OPTIONS` when its `Origin` header is present and is neither `<scheme>://<Host>` for the request's own scheme and `Host` nor, for a request to the `POSTREEVE_PUBLIC_URL` host, that URL's origin; or when `Origin` is absent and `Sec-Fetch-Site` is `cross-site` or `same-site`. The scheme SHALL come from `Fly-Forwarded-Proto` or `X-Forwarded-Proto` only when `POSTREEVE_TRUST_PROXY` is `1` or `true`. Session cookies alone SHALL NOT authorize a cross-site write.

#### Scenario: Same-origin send
- **WHEN** the web interface at `http://127.0.0.1:3000` posts to `/api/messages/send`
- **THEN** the request is handled

#### Scenario: Cross-site form post
- **WHEN** a page at `http://localhost:8080` posts to `http://localhost:3000/api/messages/send`
- **THEN** the response is 403 and nothing is sent

#### Scenario: Sibling subdomain without Origin
- **WHEN** a request without `Origin` posts to `/api/auth/login/password` with `Sec-Fetch-Site: same-site`
- **THEN** the response is 403

#### Scenario: Hosted origin behind a proxy
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://postreeve.fly.dev` and the page posts with `Origin: https://postreeve.fly.dev` over the proxy's plain-http connection
- **THEN** the request is handled

#### Scenario: Desktop app
- **WHEN** the desktop protocol proxy forwards a `POST` with the launch token and `Origin: postreeve://app`
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

### Requirement: Optional bearer token for the desktop sidecar
When `POSTREEVE_DESKTOP_TOKEN` is set to a non-blank value, the server SHALL require `Authorization: Bearer <token>` with exactly that token on every `/api/*` request except `GET /api/oauth/google/callback`, SHALL answer any other request with 401 `{ error: "Unauthorized" }`, and SHALL NOT require an owner session. When it is unset or blank, the API SHALL require the owner's session instead (runtime/owner-auth). When `POSTREEVE_DESKTOP_URL` is set, Google OAuth results SHALL redirect to that URL with the `google` and `accountId` query instead of to `/`.

#### Scenario: Missing token
- **WHEN** the server runs with a desktop token and a request to `/api/health` has no `Authorization` header
- **THEN** the response is 401

#### Scenario: Google callback without token
- **WHEN** Google redirects the browser to `/api/oauth/google/callback` on a server with a desktop token
- **THEN** the request is handled without a token and is protected by its OAuth `state`

#### Scenario: Desktop token without owner
- **WHEN** the server runs with a desktop token, no owner exists, and the desktop app requests `/api/accounts` with the token
- **THEN** the request is handled
