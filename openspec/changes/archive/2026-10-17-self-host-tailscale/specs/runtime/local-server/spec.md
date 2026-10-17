## MODIFIED Requirements

### Requirement: Docker Compose publishes only on loopback
The Compose deployment SHALL build the server image, publish container port 3000 only on host address `127.0.0.1` (port `POSTREEVE_HOST_PORT`, default 3000), refuse to start without `POSTREEVE_MASTER_KEY` from the host environment or `.env`, pass `POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY`, `POSTREEVE_SETUP_TOKEN` and the Google settings through, store the database at `/app/data/postreeve.sqlite` in the named volume `postreeve-data`, write backups to `/app/backups` mounted from `POSTREEVE_BACKUP_HOST_DIR` (default `./backups`), restart it unless stopped and allow 30 seconds for it to stop. Inside the container the server SHALL listen on `0.0.0.0` so the published port reaches it. The container SHALL start as root only to give the `bun` user ownership of the data and backup directories and SHALL then run the server as the unprivileged `bun` user. The image SHALL report health by requesting `/api/health` on loopback and SHALL NOT contain `.env`, database or backup files.

#### Scenario: Starting with Compose
- **WHEN** a user runs `docker compose up --build` after `bun run setup:local`
- **THEN** Postreeve is reachable at `http://127.0.0.1:3000` on the host and not on other host interfaces, and the container reports healthy

#### Scenario: Recreating the container
- **WHEN** the container is removed and started again
- **THEN** accounts and history persist in the `postreeve-data` volume

#### Scenario: Root-owned bind mount
- **WHEN** the backup directory on the host was created by root
- **THEN** the container hands it to `bun` before starting and the server process runs with uid 1000

## ADDED Requirements

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
