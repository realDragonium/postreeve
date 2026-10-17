# Design

## Context

The first plan targeted Fly.io; the owner changed the target before anything was committed to run on their own always-on machine on a Tailscale tailnet. Owner login (`feat/owner-auth`) owns `src/server/security/*`, the host check and the `POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY` and `POSTREEVE_SETUP_TOKEN` variables. This change uses those names and does not touch the security modules.

## Decisions

### Serving: loopback plus `tailscale serve`

Postreeve keeps listening on `127.0.0.1` (Compose publishes `127.0.0.1:3000` only) and `tailscale serve` terminates HTTPS at `https://<machine>.<tailnet>.ts.net`. Nothing binds to the LAN, the URL is a secure context for passkeys, and Tailscale handles certificates. Alternatives rejected: binding to the Tailscale interface address (no TLS, breaks WebAuthn), Caddy with a ts.net certificate (another moving part for the same result).

Until owner login merges, the host check rejects the ts.net name with 403. That is the safe failure, and the docs say hosting requires that change.

### Google OAuth redirect

`googleRedirectUri(env, port)` returns `${origin}/api/oauth/google/callback` when `POSTREEVE_PUBLIC_URL` is set, else the existing loopback URI. The public URL must be `https://` (plain `http://` only for loopback names) and an origin without path, query or credentials, because the server serves the app at `/` and Google rejects userinfo. Invalid values fail startup when Google is configured, so a typo shows up at boot rather than as a Google error page.

Google's rule for Web client redirect URIs is HTTPS and a host whose TLD is on the Public Suffix List; `*.ts.net` ends in `.net`, and Google never has to reach the host because the browser follows the redirect. So the ts.net URL should be accepted, but this was not tried against a live Google project. The fallback is `POSTREEVE_GOOGLE_REDIRECT=loopback` with a Desktop client, completing consent from a browser on the machine or through `ssh -L 3000:127.0.0.1:3000`. The refresh token then works from anywhere. An explicit setting beats guessing, and it costs one branch.

State, PKCE and the 10-minute single-use session are unchanged. `complete()` reads only the callback's query, so the internal request URL behind the proxy does not matter. The callback must stay reachable by the owner's logged-in browser; that is owner login's responsibility.

### Backups: in-process `VACUUM INTO` snapshots

Chosen: the server writes `postreeve-<UTC stamp>.sqlite` with `VACUUM INTO` through a separate read-only connection when the newest snapshot is older than `POSTREEVE_BACKUP_INTERVAL_HOURS` (default 24), checking at startup and hourly, keeping `POSTREEVE_BACKUP_KEEP` (default 7). Off unless `POSTREEVE_BACKUP_DIR` is set; Compose and the systemd unit set it, so `bun run start` for development does not litter snapshots.

- In-process means it works the same under Compose, systemd and launchd with no cron or timer to install.
- `VACUUM INTO` yields a consistent, compacted, standalone file while the server writes (WAL mode), unlike copying the file.
- A partial file is renamed into place only when complete, so rotation and off-machine copies never see half a snapshot.
- Cost: `bun:sqlite` is synchronous, so the server pauses for the copy (seconds for hundreds of MB). Acceptable once a day; moving it to a worker is a later optimization if databases grow.

Rejected: Litestream (continuous replication, but needs object storage and a supervisor process; overkill for one home machine and was only attractive for Fly's ephemeral hosts), a systemd timer (does not cover Compose).

Off-machine copies are documented with restic and rclone, not built in. Snapshots hold mail in plain text, so the docs push encrypted tools.

Restore runs `PRAGMA integrity_check` and checks the `accounts` table, moves the current database and its `-wal`/`-shm` files to `.pre-restore-<stamp>`, then writes the snapshot with `VACUUM INTO` to a staging name and renames it. Nothing is deleted, so a wrong restore is reversible. The server must be stopped; the CLI cannot detect a running server reliably across Docker and systemd, so the docs make it a step.

`busy_timeout = 5000` on the server connection: a CLI snapshot from a second process holds a read transaction, and without a timeout a write that hits a lock fails at once.

### Graceful shutdown

`createShutdown` is idempotent: `server.stop(false)` (stop accepting, resolve when in-flight requests finish), abort a shutdown signal that ends every `/api/events` stream (otherwise they never finish), `synchronization.stop()` (closes IMAP IDLE watches, aborts and awaits the running pass), then close the store and exit 0. If draining exceeds `POSTREEVE_SHUTDOWN_TIMEOUT_MS` (20 s) it calls `server.stop(true)`. Compose `stop_grace_period` and systemd `TimeoutStopSec` are 30 s, so the process finishes before the kill. Draft sends interrupted anyway are already recovered at startup.

The previous code stopped synchronization first and then dropped every connection, cutting in-flight writes such as a send.

### Container

- `oven/bun:1.4.0-slim` pinned by digest in one `ARG`; a separate stage installs production dependencies only.
- The runtime image holds `node_modules`, `src/server`, `src/shared`, `dist`, `scripts/backup.ts`, nothing from `tests`, `electron`, `openspec`, `.env` or data.
- The entrypoint runs as root only to `chown` the data and backup directories (host bind mounts arrive root-owned), then `exec setpriv` to `bun`. `setpriv` ships in the slim image, so no extra package.
- `HEALTHCHECK` uses `bun -e fetch(...)` against loopback, which the host check always accepts, so no curl is installed.

### Native service

The systemd unit runs as a `postreeve` system user with `StateDirectory=postreeve`, `ProtectSystem=strict` and `/var/lib/postreeve` as its only writable path, binds 127.0.0.1 and reads secrets from a root-owned `EnvironmentFile`. The launchd plist is included because it is small; it is not tested.

### CI

`.github/workflows/verify.yml` runs `bun run verify`, `bunx openspec validate --specs --strict` and `docker build` on pull requests and pushes to `main`. No deploy job: the target is a home machine and pushing to it from GitHub would need inbound access or a tailnet key in CI.

### Funnel

Documented only, off by default: a separate Funnel port with only the MCP and OAuth paths, never the 443 serve config. The owner has not decided; the risks are listed in the guide.

## Risks

- ts.net acceptance by Google is unverified; mitigated by the loopback fallback.
- Snapshots on the same disk do not survive disk loss; the docs make off-machine copies the owner's step.
- `docker build` was verified in the sandbox with an injected proxy CA in a test-only copy of the Dockerfile; the committed Dockerfile is unchanged by that.
