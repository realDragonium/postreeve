## ADDED Requirements

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
