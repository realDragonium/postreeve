# Proposal

## Why

The owner wants to use Postreeve daily from several devices, running on their own always-on machine that is already on a Tailscale tailnet. Today Postreeve only documents a loopback Docker Compose run: Google OAuth can only redirect to `127.0.0.1`, the only copy of the data is one SQLite file, the container runs without a health check, and SIGTERM drops in-flight requests. This change makes that machine a supported host. It belongs to the hosted-Postreeve effort; owner login (`feat/owner-auth`) is built in parallel and is required before the tailnet URL is served.

## What Changes

- Google OAuth uses `${POSTREEVE_PUBLIC_URL}/api/oauth/google/callback` with a Google "Web application" client when `POSTREEVE_PUBLIC_URL` is set, and keeps the loopback callback otherwise. `POSTREEVE_GOOGLE_REDIRECT=loopback` forces the loopback callback as a fallback. State and PKCE handling are unchanged.
- Scheduled local backups: with `POSTREEVE_BACKUP_DIR` set, the server writes rotated `VACUUM INTO` snapshots. New `bun run backup` command creates, lists, verifies and restores snapshots; restore moves the current database aside instead of deleting it.
- Graceful shutdown: on SIGTERM/SIGINT the server stops accepting requests, ends event streams, waits for in-flight requests and the synchronization pass (closing IMAP IDLE), then closes the database, bounded by `POSTREEVE_SHUTDOWN_TIMEOUT_MS`.
- Docker image: pinned Bun slim image by digest, production dependencies only, only server/shared/dist files, health check, entrypoint that fixes volume ownership and drops to `bun`. `.dockerignore` keeps `.env`, data and backups out.
- Compose: required master key, hosted settings passed through, backups to a host directory, 30-second stop grace period.
- Native Linux service: hardened systemd unit; untested macOS LaunchAgent.
- SQLite `busy_timeout` of 5 seconds so a separate backup or CLI connection never makes the server fail with `SQLITE_BUSY`.
- `docs/self-host-tailscale.md`: both run modes, `tailscale serve`, Google web client and loopback fallback, updating, backups/restore, off-machine copies, secret rotation, logs, and opt-in Funnel for remote MCP with its risks.
- GitHub Actions CI: `bun run verify`, OpenSpec validation and `docker build` on pull requests and `main`.
- WebMCP: no changes.

## Capabilities

### New Capabilities

- `runtime/self-hosting`: local backups and restore, the systemd service, the Tailscale serving model.

### Modified Capabilities

- `runtime/local-server`: graceful shutdown; Compose deployment gains health check, backups and hosted settings; the container drops privileges in its entrypoint.
- `accounts/gmail-accounts`: redirect URI follows `POSTREEVE_PUBLIC_URL`, with a loopback override.

## Impact

- `src/server/google/oauth.ts`, `src/server/index.ts`, `src/server/api.ts`, `src/server/db/store.ts`
- New `src/server/runtime/shutdown.ts`, `src/server/runtime/backup.ts`, `scripts/backup.ts`
- `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/`, `.github/workflows/verify.yml`, `docs/self-host-tailscale.md`, `README.md`
- No change to `src/server/security/*` (owned by the owner-login change).
