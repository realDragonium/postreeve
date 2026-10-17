# runtime/self-hosting Specification

## Purpose
Covers running Postreeve on the owner's always-on machine: scheduled local snapshots and their rotation, the backup and restore command, the native Linux service and the documented `tailscale serve` model. The server process, graceful shutdown and the Compose deployment are specified in runtime/local-server; the hosted Google redirect URI in accounts/gmail-accounts.

## Requirements

### Requirement: Scheduled local snapshots
When `POSTREEVE_BACKUP_DIR` is set, the server SHALL write a snapshot of the database named `postreeve-<YYYYMMDDTHHMMSSZ>.sqlite` (UTC) into that directory with `VACUUM INTO` through a separate read-only connection, at startup and on hourly checks, whenever the newest snapshot there is older than `POSTREEVE_BACKUP_INTERVAL_HOURS` (default 24). When the variable is unset no snapshots SHALL be written. A failed snapshot SHALL be logged and SHALL NOT stop the server.

#### Scenario: First start with backups enabled
- **WHEN** the server starts with an empty backup directory
- **THEN** one snapshot is written and logged before the next hourly check

#### Scenario: Restart within the interval
- **WHEN** the server restarts two hours after the last snapshot with the default interval
- **THEN** no new snapshot is written

### Requirement: Snapshot files and rotation
Each snapshot SHALL be written under a temporary name and renamed when complete, with mode `0600`. After each snapshot the newest `POSTREEVE_BACKUP_KEEP` (default 7) `postreeve-*.sqlite` files SHALL remain and older ones SHALL be deleted. Each snapshot SHALL be logged on one line.

#### Scenario: Rotation
- **WHEN** a new snapshot is written and `POSTREEVE_BACKUP_KEEP` is 2
- **THEN** only the two newest `postreeve-*.sqlite` files remain

### Requirement: Invalid backup settings stop startup
The server SHALL refuse to start when `POSTREEVE_BACKUP_DIR` is set and `POSTREEVE_BACKUP_INTERVAL_HOURS` is not a number greater than 0 and at most 744, or `POSTREEVE_BACKUP_KEEP` is not an integer from 1 to 1000.

#### Scenario: Zero snapshots kept
- **WHEN** `POSTREEVE_BACKUP_KEEP` is `0`
- **THEN** the server exits during startup without listening

### Requirement: Backup command
`bun run backup` SHALL create and verify a snapshot in `POSTREEVE_BACKUP_DIR` (default `./backups`) of `POSTREEVE_DB_PATH` while the server may be running. `bun run backup list` SHALL print the snapshots oldest first, and `bun run backup verify <file>` SHALL fail unless the file passes `PRAGMA integrity_check` and contains the `accounts` table.

#### Scenario: Snapshot while the server runs
- **WHEN** an operator runs `bun run backup` while the server is writing
- **THEN** a consistent snapshot is written and verified

### Requirement: Restore keeps the replaced database
`bun run backup restore <file>` SHALL verify the snapshot as `verify` does and fail without changing anything if it does not pass. Otherwise it SHALL move the current database and its `-wal` and `-shm` files to `<database>.pre-restore-<stamp>`, write the snapshot to the database path with mode `0600`, and print where the previous database was kept. It SHALL NOT delete any file.

#### Scenario: Restoring yesterday's snapshot
- **WHEN** the server is stopped and the operator restores a snapshot
- **THEN** the database contains the snapshot's data, the previous database is kept beside it, and the server starts with the same master key

#### Scenario: Corrupt snapshot
- **WHEN** the operator restores a file that is not a Postreeve database
- **THEN** the command fails and the current database is unchanged

### Requirement: Native Linux service
The repository SHALL provide a systemd unit that runs the server as a dedicated `postreeve` user from `/opt/postreeve`, reads secrets from `/etc/postreeve/postreeve.env`, listens on `127.0.0.1:3000` with `POSTREEVE_TRUST_PROXY=1`, stores the database and snapshots under `/var/lib/postreeve` as its only writable path, restarts on failure and allows 30 seconds for a graceful stop.

#### Scenario: Service start
- **WHEN** the owner enables the unit after creating the environment file
- **THEN** Postreeve answers `http://127.0.0.1:3000/api/health` and writes its first snapshot to `/var/lib/postreeve/backups`

### Requirement: Tailnet serving model
The documented hosted setup SHALL run Postreeve with Docker Compose, published only on the host's loopback, and SHALL reach it through the host's `tailscale serve` at `https://<machine>.<tailnet>.ts.net`, with `POSTREEVE_PUBLIC_URL` set to that origin and `POSTREEVE_TRUST_PROXY=1`. It SHALL state that owner login is required before serving it.

#### Scenario: Other tailnet device
- **WHEN** the owner opens the ts.net URL on a phone in the tailnet
- **THEN** the page loads over HTTPS and the server is not reachable on the machine's LAN address

### Requirement: Funnel is documented on a separate port
The documented setup SHALL describe Tailscale Funnel only on a separate port that maps the Funnel public paths and nothing else, keeping the web UI and `/api` tailnet-only, and SHALL list its risks.

#### Scenario: Funnel enabled
- **WHEN** the owner follows the Funnel steps
- **THEN** port 8443 is public for the Funnel public paths only and port 443 stays tailnet-only

### Requirement: Funnel requests reach only the public MCP paths
The server SHALL answer 404 `{ error: "Not found" }`, before any other handler, to a request carrying a `Tailscale-Funnel-Request` header unless its path is `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register` or `/oauth/token`, or a sub-path of one of them, and contains no `%` or `\`. Requests without the header SHALL pass unchanged. `/oauth/authorize` SHALL NOT be a Funnel public path.

#### Scenario: Connector calls MCP
- **WHEN** a Funnel request posts to `/mcp`
- **THEN** it reaches the MCP handler

#### Scenario: Internet request for the UI
- **WHEN** a Funnel request asks for `/`, `/api/accounts` or `/oauth/authorize`
- **THEN** the response is 404 and no other handler runs

#### Scenario: Tailnet request
- **WHEN** a request through `tailscale serve` on the tailnet asks for `/api/accounts`
- **THEN** the guard does not affect it
