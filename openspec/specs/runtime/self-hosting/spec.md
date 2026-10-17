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
The documented hosted setup SHALL run Postreeve with Docker Compose published only on the host's loopback. It SHALL make the web UI and `/api` reachable only from the tailnet through the host's `tailscale serve` at `https://<machine>.<tailnet>.ts.net`, with `POSTREEVE_PUBLIC_URL` set to that origin and `POSTREEVE_TRUST_PROXY=1`. It SHALL state that owner login is required before serving it.

#### Scenario: Other tailnet device
- **WHEN** the owner opens the ts.net URL on a phone in the tailnet
- **THEN** the page loads over HTTPS and the server is not reachable on the machine's public address

### Requirement: Public traffic goes only through Caddy
The documented setup SHALL describe installing Tailscale on the host, SHALL route all public web traffic through Caddy, and SHALL never forward port 3000 to the internet.

#### Scenario: Caddy configuration
- **WHEN** the owner copies the guide's Caddyfile
- **THEN** no site block proxies to port 3000

### Requirement: Funnel requests reach only the public MCP paths
The server SHALL answer a bare 404 with no body, before any other handler, to a request carrying a `Tailscale-Funnel-Request` header unless its path is `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` or `/oauth/revoke`, or a sub-path of one of them, and contains no `%` or `\`. Requests without the header SHALL pass unchanged.

#### Scenario: Connector calls MCP
- **WHEN** a Funnel request posts to `/mcp`
- **THEN** it reaches the MCP handler

#### Scenario: Connector reads resource metadata
- **WHEN** a Funnel request asks for `/.well-known/oauth-protected-resource/mcp`
- **THEN** it reaches the metadata handler

#### Scenario: Connector revokes a token
- **WHEN** a Funnel request posts to `/oauth/revoke`
- **THEN** it reaches the revocation handler

#### Scenario: Internet request for the UI
- **WHEN** a Funnel request asks for `/`, `/api/accounts` or `/oauth/authorize`
- **THEN** the response is 404 with an empty body and no other handler runs

#### Scenario: Tailnet request
- **WHEN** a request through `tailscale serve` on the tailnet asks for `/api/accounts`
- **THEN** the guard does not affect it

### Requirement: The Funnel guard does not depend on proxy trust
The Funnel guard SHALL apply whether or not `POSTREEVE_TRUST_PROXY` is set, and `/oauth/authorize` SHALL NOT be a Funnel public path, so the consent page and owner login stay tailnet-only.

#### Scenario: Proxy trust not configured
- **WHEN** `POSTREEVE_TRUST_PROXY` is unset and a Funnel request asks for `/api/accounts`
- **THEN** the response is 404

#### Scenario: Consent page over Funnel
- **WHEN** a Funnel request asks for `/oauth/authorize`
- **THEN** the response is 404

### Requirement: Same-host mail server guidance
The self-hosting guide SHALL explain running next to a mail server on a public-IP host: Caddy as the single public TLS front on 80 and 443, putting poste.io behind Caddy, the public routes for Stalwart, how `tailscale serve` on 443 coexists with Caddy and a fallback port if it does not, separate Docker networks, connecting to the mail server by its public hostname, and required off-machine backups.

#### Scenario: poste.io on the same VPS
- **WHEN** the owner follows the guide on a VPS where Caddy holds the public 443 and poste.io sits behind it
- **THEN** tailnet devices reach Postreeve at the ts.net URL, the public name reaches poste.io webmail, and the mail ports reach poste.io directly

### Requirement: Public front and firewall guidance
The guide SHALL document Caddy's `X-Forwarded-For` behavior (client values discarded unless `trusted_proxies` is set), a default-deny firewall that allows only SSH, 80, 443 and the mail ports from the internet, and that Docker-published ports bypass ufw so every non-mail container port publishes on `127.0.0.1`. It SHALL describe the public MCP listener (`POSTREEVE_PUBLIC_MCP_PORT`, `POSTREEVE_MCP_PUBLIC_URL`) behind `mcp.<domain>` and mark it as not yet available until it is wired.

#### Scenario: Port scan from outside
- **WHEN** the owner scans the VPS's public IP after following the guide
- **THEN** only 22 (until moved to the tailnet), 25, 80, 443, 465, 587 and 993 are open
