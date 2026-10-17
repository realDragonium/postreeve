# Self-hosting Postreeve over Tailscale

Postreeve runs on one always-on machine in your tailnet. It listens on `127.0.0.1:3000` only, and `tailscale serve` gives it HTTPS at `https://<machine>.<tailnet>.ts.net` for your other devices. Nothing binds to the LAN, and nothing is reachable from the internet unless you opt in to Funnel (last section).

> **Owner login must be in place first.** Through `tailscale serve`, every device in your tailnet can reach Postreeve. Do not set `POSTREEVE_PUBLIC_URL` and serve it until the owner-login change (`POSTREEVE_SETUP_TOKEN`, the host check for `POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY`) is merged. Before that, the host check rejects the ts.net name with 403 and the app works only on loopback, which is the safe failure.

Two supported ways to run it: Docker Compose, or a native service (systemd on Linux; a launchd file for macOS is included but untested). Both use the same settings:

| Variable | Value |
| --- | --- |
| `POSTREEVE_MASTER_KEY` | 32 random bytes, base64. Encrypts stored mail credentials. |
| `POSTREEVE_PUBLIC_URL` | `https://<machine>.<tailnet>.ts.net`, the origin only, no path |
| `POSTREEVE_TRUST_PROXY` | `1`: trust `X-Forwarded-Proto` from `tailscale serve` |
| `POSTREEVE_SETUP_TOKEN` | One-time token to claim the owner account on first run |
| `POSTREEVE_GOOGLE_CLIENT_ID`, `POSTREEVE_GOOGLE_CLIENT_SECRET` | Google OAuth client (optional) |
| `POSTREEVE_GOOGLE_REDIRECT` | `loopback` to force the loopback OAuth callback (see Google section) |
| `POSTREEVE_BACKUP_DIR` | Snapshot directory; backups are off when unset |
| `POSTREEVE_BACKUP_INTERVAL_HOURS`, `POSTREEVE_BACKUP_KEEP` | Defaults `24` and `7` |
| `POSTREEVE_SHUTDOWN_TIMEOUT_MS` | Drain time on SIGTERM, default `20000` |

## The master key

Losing `POSTREEVE_MASTER_KEY` or changing it makes every stored mailbox password and Google refresh token unrecoverable; you would have to add each account again. Mail content in the database is not encrypted by this key, so the key does not protect a stolen database's mail, only the credentials. Store a copy of the key in your password manager, separate from the backups.

Generate it straight into a file so it never appears on screen or in shell history (only the command does):

```bash
# Docker Compose: creates ./.env with a key, without printing it
bun run setup:local

# Native service: writes the key into the root-owned environment file
sudo install -d -m 700 /etc/postreeve
sudo sh -c 'umask 077; printf "POSTREEVE_MASTER_KEY=%s\nPOSTREEVE_SETUP_TOKEN=%s\n" "$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > /etc/postreeve/postreeve.env'
```

To copy the key into a password manager, open the file in an editor (`sudo -e /etc/postreeve/postreeve.env`) instead of `cat`-ing it into terminal scrollback.

## Option A: Docker Compose

```bash
git clone https://github.com/realDragonium/postreeve.git && cd postreeve
bun run setup:local            # or create .env by hand with POSTREEVE_MASTER_KEY=
```

Add the hosted settings to `.env` (Compose reads it for variable substitution; the container does not see the other local-development lines):

```bash
POSTREEVE_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
POSTREEVE_TRUST_PROXY=1
POSTREEVE_SETUP_TOKEN=<openssl rand -hex 24>
# POSTREEVE_BACKUP_HOST_DIR=/srv/postreeve-backups   # default ./backups
```

```bash
docker compose up -d --build
docker compose ps              # STATUS shows (healthy) after ~30 s
curl -sf http://127.0.0.1:3000/api/health
```

Compose publishes only `127.0.0.1:3000`, keeps the database in the `postreeve-data` volume, writes snapshots to `./backups` (or `POSTREEVE_BACKUP_HOST_DIR`), restarts unless stopped, and gives the server 30 seconds to drain on stop. The container starts as root only to give the `bun` user its data and backup directories, then drops to `bun`.

## Option B: systemd (Linux)

```bash
# Bun system-wide, readable by the service user
curl -fsSL https://bun.sh/install | sudo env BUN_INSTALL=/usr/local bash

sudo useradd --system --home-dir /var/lib/postreeve --shell /usr/sbin/nologin postreeve
sudo git clone https://github.com/realDragonium/postreeve.git /opt/postreeve
cd /opt/postreeve && sudo bun install --frozen-lockfile && sudo bun run build
```

Create `/etc/postreeve/postreeve.env` as in [The master key](#the-master-key), then add the rest:

```bash
sudo sh -c 'cat >> /etc/postreeve/postreeve.env' <<'EOF'
POSTREEVE_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
EOF
sudo cp deploy/systemd/postreeve.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now postreeve
curl -sf http://127.0.0.1:3000/api/health
```

The unit runs as `postreeve`, keeps data and snapshots in `/var/lib/postreeve` (the only writable path), binds `127.0.0.1:3000`, sets `POSTREEVE_TRUST_PROXY=1`, and allows 30 seconds for a graceful stop. If Bun lives elsewhere, edit `ExecStart`.

### macOS

`deploy/launchd/nl.dragonium.postreeve.plist` is a LaunchAgent with the same settings. Replace the `YOU`, `MACHINE.TAILNET` and key placeholders, `chmod 600` it (it contains the key), copy it to `~/Library/LaunchAgents/` and run `launchctl load ~/Library/LaunchAgents/nl.dragonium.postreeve.plist`. It is not tested in CI.

## HTTPS with `tailscale serve`

Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page), then on the Postreeve machine:

```bash
sudo tailscale serve --bg http://127.0.0.1:3000
tailscale serve status         # shows https://<machine>.<tailnet>.ts.net -> http://127.0.0.1:3000
```

Open `https://<machine>.<tailnet>.ts.net` from any device in the tailnet. This is a secure context, so passkeys (WebAuthn) work. The configuration persists across reboots; remove it with `sudo tailscale serve --https=443 off`.

The certificate is issued by Let's Encrypt, so the machine and tailnet names appear in public Certificate Transparency logs. The service itself stays unreachable from the internet.

## Google accounts

### Web client on the ts.net URL (try this first)

1. In Google Cloud Console, enable the Gmail API and configure the OAuth consent screen (External, Testing, add yourself as a test user, scope `https://www.googleapis.com/auth/gmail.modify`).
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Authorized redirect URI: `https://<machine>.<tailnet>.ts.net/api/oauth/google/callback`. No JavaScript origin is needed.
4. Set `POSTREEVE_GOOGLE_CLIENT_ID` and `POSTREEVE_GOOGLE_CLIENT_SECRET` (in `.env` for Compose, in `/etc/postreeve/postreeve.env` for systemd) and restart.

With `POSTREEVE_PUBLIC_URL` set, Postreeve sends that exact redirect URI. Google only requires the redirect host to be HTTPS and end in a TLD on the Public Suffix List; `.net` qualifies, and Google never has to reach the host because your browser follows the redirect. The ts.net name should therefore be accepted. This has not been tried against a live Google project from this repository, so if the console refuses the URI, use the fallback.

Testing-mode apps get refresh tokens that expire after 7 days; reauthorize from Settings when Postreeve asks.

### Fallback: loopback desktop client

1. Create an OAuth client of type **Desktop app** instead, and set its ID and secret as above.
2. Set `POSTREEVE_GOOGLE_REDIRECT=loopback` and restart. Postreeve then sends `http://127.0.0.1:3000/api/oauth/google/callback` even with a public URL.
3. Connect each Google account from a browser that reaches the server as `127.0.0.1:3000`: either on the machine itself, or through an SSH tunnel from your laptop:

   ```bash
   ssh -N -L 3000:127.0.0.1:3000 <machine>
   # then open http://127.0.0.1:3000 locally and choose Continue with Google
   ```

After connecting, use the ts.net URL as usual; the stored refresh token works from anywhere. Repeat the tunnel step only to add or reauthorize a Google account.

## Updating

```bash
# Compose
git pull && docker compose up -d --build

# systemd
cd /opt/postreeve && sudo git pull && sudo bun install --frozen-lockfile && sudo bun run build && sudo systemctl restart postreeve
```

Take a snapshot first (`bun run backup`, see below) when an update changes the database schema. Postreeve migrates the database on startup and does not migrate it back.

## Backups and restore

With `POSTREEVE_BACKUP_DIR` set (Compose and systemd set it), the server writes `postreeve-<UTC timestamp>.sqlite` with `VACUUM INTO` when the newest snapshot is older than `POSTREEVE_BACKUP_INTERVAL_HOURS`, checking at startup and hourly, and keeps the newest `POSTREEVE_BACKUP_KEEP`. Snapshots are consistent while the server runs, are `0600`, and contain the encrypted credentials plus all mail content in plain text. They do not contain the master key; keep that separately.

A snapshot pauses the server for as long as SQLite takes to copy the database, typically a few seconds per few hundred MB.

Manual commands (they read `POSTREEVE_DB_PATH` and `POSTREEVE_BACKUP_DIR`):

```bash
# Compose
docker compose exec -u bun postreeve bun run backup            # snapshot now, verified
docker compose exec -u bun postreeve bun run backup list

# systemd
cd /opt/postreeve && sudo -u postreeve env POSTREEVE_DB_PATH=/var/lib/postreeve/postreeve.sqlite \
  POSTREEVE_BACKUP_DIR=/var/lib/postreeve/backups bun run backup
```

### Restore

Restore checks the snapshot with `PRAGMA integrity_check`, moves the current database and its WAL files aside to `postreeve.sqlite.pre-restore-<timestamp>` (nothing is deleted), and copies the snapshot into place. Stop the server first.

```bash
# Compose
docker compose stop postreeve
docker compose run --rm postreeve bun run backup restore /app/backups/postreeve-20261017T030000Z.sqlite
docker compose start postreeve

# systemd
sudo systemctl stop postreeve
cd /opt/postreeve && sudo -u postreeve env POSTREEVE_DB_PATH=/var/lib/postreeve/postreeve.sqlite \
  bun run backup restore /var/lib/postreeve/backups/postreeve-20261017T030000Z.sqlite
sudo systemctl start postreeve
```

The restored server needs the same `POSTREEVE_MASTER_KEY`. Delete the `.pre-restore-*` files once the restored state looks right.

### Off-machine copies

Snapshots on the same disk protect against bad updates and mistakes, not against losing the machine. Copy the snapshot directory elsewhere with a tool you already use; Postreeve does not build this in. Copy only finished `postreeve-*.sqlite` files, never the live `/app/data` or `/var/lib/postreeve/postreeve.sqlite`. Because snapshots hold mail in plain text, use an encrypting tool:

```bash
# restic (encrypted, deduplicated), e.g. from a daily systemd timer or cron
restic -r sftp:backup-host:/srv/restic/postreeve backup /var/lib/postreeve/backups --include 'postreeve-*.sqlite'

# rclone to an encrypted "crypt" remote
rclone copy /var/lib/postreeve/backups secret-remote:postreeve --include 'postreeve-*.sqlite'
```

For Compose the directory is `./backups` or your `POSTREEVE_BACKUP_HOST_DIR`. To restore from off-machine, fetch one snapshot into the backup directory and follow the restore steps.

## Rotating secrets

- **Setup token:** only used to claim the owner account. After claiming, remove or replace it and restart.
- **Google client secret:** create a new secret in Cloud Console, update the environment file, restart, then delete the old secret. Stored refresh tokens stay valid for the same client ID.
- **Master key:** Postreeve cannot re-encrypt credentials with a new key yet. Changing the key means removing and re-adding every account. Rotate it only if it leaked.
- **Mailbox passwords:** change the app password at the provider, then update the account in Postreeve.

## Logs

```bash
docker compose logs -f postreeve
journalctl -u postreeve -f
```

Postreeve logs `Postreeve listening on http://127.0.0.1:3000` at start, one line per backup, and `Postreeve is shutting down` / `Postreeve stopped` on stop. On SIGTERM it stops accepting requests, ends open event streams, waits for in-flight requests and the running synchronization pass (IMAP IDLE connections close), then closes the database. After `POSTREEVE_SHUTDOWN_TIMEOUT_MS` it closes remaining connections.

## Optional: Tailscale Funnel for remote MCP (off by default)

Cloud MCP connectors (claude.ai, ChatGPT) run outside your tailnet, so they cannot reach a `tailscale serve` URL. Funnel can publish selected paths to the internet. This is opt-in and not enabled by any file in this repository.

Funnel publishes everything served on a port, so put the public paths on their own Funnel port (8443 or 10000) and keep the full app tailnet-only on 443:

```bash
# Requires the "funnel" node attribute in your tailnet policy file.
sudo tailscale funnel --bg --https=8443 --set-path=/mcp http://127.0.0.1:3000/mcp
# Add one --set-path per OAuth endpoint the remote MCP server documents (for example /.well-known/... and /oauth/...).
tailscale funnel status
# Turn it off again
sudo tailscale funnel --https=8443 off
```

Risks before you enable it:

- Anyone on the internet can send requests to those paths. Their safety rests entirely on the MCP server's OAuth and on the owner-login checks; there is no tailnet identity on Funnel traffic.
- The connector would hold a token that can read your mail and prepare actions. Only the human UI can approve proposals, but reading is enough to leak mail.
- The public origin is `https://<machine>.<tailnet>.ts.net:8443`, not `POSTREEVE_PUBLIC_URL`; the MCP server's OAuth metadata and host checks must accept that origin.
- Your home machine receives internet traffic, including scanners.

Prefer a local MCP client inside the tailnet when it can do the job.
