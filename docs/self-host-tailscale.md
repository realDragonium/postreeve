# Self-hosting Postreeve over Tailscale

Postreeve runs in Docker Compose on one always-on Linux machine in your tailnet. The container publishes only `127.0.0.1:3000` on the host, and the host's own `tailscale serve` gives it HTTPS at `https://<machine>.<tailnet>.ts.net` for your other devices. Nothing binds to the LAN. Optionally, Tailscale Funnel publishes only the remote MCP endpoints to the internet so cloud connectors can reach them ([last section](#remote-mcp-through-tailscale-funnel)).

> **Owner login must be in place first.** Every device in your tailnet can reach the ts.net URL. Do not serve it until the owner-login change (`POSTREEVE_SETUP_TOKEN`, the host check for `POSTREEVE_PUBLIC_URL`, `POSTREEVE_TRUST_PROXY`) is merged. Before that, the host check rejects the ts.net name with 403 and the app works only on loopback, which is the safe failure.

## Settings

| Variable | Value |
| --- | --- |
| `POSTREEVE_MASTER_KEY` | 32 random bytes, base64. Encrypts stored mail credentials. |
| `POSTREEVE_PUBLIC_URL` | `https://<machine>.<tailnet>.ts.net`, the origin only, no path |
| `POSTREEVE_TRUST_PROXY` | `1`: trust `X-Forwarded-Proto` from `tailscale serve` |
| `POSTREEVE_SETUP_TOKEN` | One-time token to claim the owner account on first run |
| `POSTREEVE_GOOGLE_CLIENT_ID`, `POSTREEVE_GOOGLE_CLIENT_SECRET` | Google OAuth client (optional) |
| `POSTREEVE_GOOGLE_REDIRECT` | `loopback` to force the loopback OAuth callback (see [Google accounts](#google-accounts)) |
| `POSTREEVE_BACKUP_INTERVAL_HOURS`, `POSTREEVE_BACKUP_KEEP` | Defaults `24` and `7` |
| `POSTREEVE_BACKUP_HOST_DIR` | Host directory for snapshots, default `./backups` |
| `POSTREEVE_HOST_PORT` | Host loopback port, default `3000` |
| `POSTREEVE_SHUTDOWN_TIMEOUT_MS` | Drain time on stop, default `20000` |

## The master key

Losing `POSTREEVE_MASTER_KEY` or changing it makes every stored mailbox password and Google refresh token unrecoverable; you would have to add each account again. The key protects only those credentials, not the mail content in the database. Keep a copy in your password manager, separate from the backups.

`bun run setup:local` writes a new key into `.env` without printing it. Without Bun on the host, generate it straight into the file so only the command reaches shell history:

```bash
umask 077; printf 'POSTREEVE_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

Copy it into your password manager by opening `.env` in an editor, not by `cat`-ing it into terminal scrollback.

## First run

```bash
git clone https://github.com/realDragonium/postreeve.git && cd postreeve
bun run setup:local            # or the openssl line above
cat >> .env <<'EOF'
POSTREEVE_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
POSTREEVE_TRUST_PROXY=1
EOF
printf 'POSTREEVE_SETUP_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env

docker compose up -d --build
docker compose ps              # STATUS shows (healthy) after about 30 s
curl -sf http://127.0.0.1:3000/api/health
```

Compose reads `.env` only to fill in the variables named in `compose.yaml`; the other local-development lines in it do not reach the container. Compose publishes only `127.0.0.1:3000`, keeps the database in the `postreeve-data` volume, writes snapshots to `./backups`, restarts unless stopped, and gives the server 30 seconds to drain on stop. The container starts as root only to give the `bun` user its data and backup directories, then drops to `bun`.

## HTTPS with `tailscale serve`

Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page), then on the host:

```bash
sudo tailscale serve --bg http://127.0.0.1:3000
tailscale serve status         # https://<machine>.<tailnet>.ts.net -> http://127.0.0.1:3000
curl -sf https://<machine>.<tailnet>.ts.net/api/health    # from another tailnet device
```

This is a secure context, so passkeys (WebAuthn) work. The configuration survives reboots; remove it with `sudo tailscale serve --https=443 off`.

What the proxy sends to Postreeve (from Tailscale's `ipn/ipnlocal/serve.go`): the original `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto: https`, and `Tailscale-User-Login`/`Tailscale-User-Name` for tailnet requests. It uses Go's `httputil.ReverseProxy` with `Rewrite`. Go deletes any client-sent `X-Forwarded-*` headers before `Rewrite` runs, and Tailscale then **sets** `X-Forwarded-For` to exactly one address: the tailnet peer's IP, or the internet client's IP for Funnel. A client cannot inject entries, so the last (and only) entry is a sound rate-limit key. That holds only for traffic through Tailscale. A process on the host can reach `127.0.0.1:3000` directly with any header it likes.

The certificate comes from Let's Encrypt, so the machine and tailnet names appear in public Certificate Transparency logs. That alone does not make the service reachable from the internet.

A `tailscale/tailscale` sidecar container with `TS_SERVE_CONFIG` would also work, but it joins the tailnet as a second node with its own name and auth key. The host is already on the tailnet, so use the host's `tailscale serve`.

## Google accounts

### Web client on the ts.net URL (try this first)

1. In Google Cloud Console, enable the Gmail API and configure the OAuth consent screen (External, Testing, add yourself as a test user, scope `https://www.googleapis.com/auth/gmail.modify`).
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Authorized redirect URI: `https://<machine>.<tailnet>.ts.net/api/oauth/google/callback`. No JavaScript origin is needed.
4. Add `POSTREEVE_GOOGLE_CLIENT_ID` and `POSTREEVE_GOOGLE_CLIENT_SECRET` to `.env` and run `docker compose up -d`.

With `POSTREEVE_PUBLIC_URL` set, Postreeve sends that exact redirect URI. Google requires the redirect host to use HTTPS and end in a TLD on the Public Suffix List. `.net` qualifies, and Google never has to reach the host because your browser follows the redirect, so the ts.net name should be accepted. This has not been tried against a live Google project from this repository; if the console refuses the URI, use the fallback.

Testing-mode apps get refresh tokens that expire after 7 days; reauthorize from Settings when Postreeve asks.

### Fallback: loopback desktop client

1. Create an OAuth client of type **Desktop app** instead and put its ID and secret in `.env`.
2. Add `POSTREEVE_GOOGLE_REDIRECT=loopback` and run `docker compose up -d`. Postreeve then sends `http://127.0.0.1:3000/api/oauth/google/callback` even with a public URL.
3. Connect each Google account from a browser that reaches the server as `127.0.0.1:3000`, either on the machine itself or through an SSH tunnel:

   ```bash
   ssh -N -L 3000:127.0.0.1:3000 <machine>
   # then open http://127.0.0.1:3000 locally and choose Continue with Google
   ```

The stored refresh token then works from the ts.net URL too. Repeat the tunnel only to add or reauthorize a Google account.

## Updating

```bash
docker compose exec -u bun postreeve bun run backup    # snapshot first
git pull && docker compose up -d --build
```

Postreeve migrates the database on startup and cannot migrate it back, so take the snapshot before an update.

## Backups and restore

The server writes `postreeve-<UTC timestamp>.sqlite` to `/app/backups` (`./backups` on the host) with `VACUUM INTO` when the newest snapshot is older than `POSTREEVE_BACKUP_INTERVAL_HOURS`. It checks at startup and hourly, and keeps the newest `POSTREEVE_BACKUP_KEEP`. Snapshots are consistent while the server runs and have mode `0600`. They contain the encrypted credentials and all mail content in plain text, but not the master key.

A snapshot pauses the server for as long as SQLite takes to copy the database, typically a few seconds per few hundred MB.

```bash
docker compose exec -u bun postreeve bun run backup              # snapshot now, verified
docker compose exec -u bun postreeve bun run backup list
docker compose exec -u bun postreeve bun run backup verify /app/backups/<file>
```

### Restore

Restore checks the snapshot with `PRAGMA integrity_check`, moves the current database and its WAL files aside to `postreeve.sqlite.pre-restore-<timestamp>` (nothing is deleted), and copies the snapshot into place. Stop the server first:

```bash
docker compose stop postreeve
docker compose run --rm postreeve bun run backup restore /app/backups/postreeve-20261017T030000Z.sqlite
docker compose start postreeve
```

The restored server needs the same `POSTREEVE_MASTER_KEY`. Delete the `.pre-restore-*` files from the volume once the restored state looks right:

```bash
docker compose run --rm postreeve sh -c 'rm /app/data/postreeve.sqlite.pre-restore-*'
```

### Off-machine copies

Snapshots on the same disk protect against bad updates and mistakes, not against losing the machine. Copy `./backups` elsewhere with a tool you already use; Postreeve does not build this in. Copy only finished `postreeve-*.sqlite` files, never the live volume. Snapshots hold mail in plain text, so use an encrypting tool, for example from a daily cron job or systemd timer:

```bash
# restic: encrypted, deduplicated
restic -r sftp:backup-host:/srv/restic/postreeve backup ./backups
# rclone to an encrypted "crypt" remote
rclone copy ./backups secret-remote:postreeve --include 'postreeve-*.sqlite'
```

To restore from off-machine, put one snapshot back into `./backups` and follow the restore steps.

## Rotating secrets

- **Setup token:** used only to claim the owner account. After claiming, remove it from `.env` and run `docker compose up -d`.
- **Google client secret:** create a new secret in Cloud Console, update `.env`, run `docker compose up -d`, then delete the old secret. Stored refresh tokens stay valid for the same client ID.
- **Master key:** Postreeve cannot re-encrypt credentials under a new key yet. Changing it means removing and re-adding every account, so rotate it only if it leaked.
- **Mailbox passwords:** change the app password at the provider, then update the account in Postreeve.

## Logs

```bash
docker compose logs -f postreeve
```

Postreeve logs `Postreeve listening on http://0.0.0.0:3000` at start, one line per backup, and `Postreeve is shutting down` / `Postreeve stopped` on stop. On SIGTERM it stops accepting requests, ends open event streams, waits for in-flight requests and the running synchronization pass (IMAP IDLE connections close), then closes the database. After `POSTREEVE_SHUTDOWN_TIMEOUT_MS` it closes remaining connections.

## Remote MCP through Tailscale Funnel

Cloud MCP connectors (claude.ai, ChatGPT) run on the vendor's servers, outside your tailnet. Funnel publishes chosen paths to the internet. The web UI and `/api` stay tailnet-only.

The public paths are fixed in `src/server/runtime/funnel-paths.ts`:

| Path | Why it is public |
| --- | --- |
| `/mcp` | The MCP endpoint the connector calls |
| `/.well-known/oauth-protected-resource` and sub-paths, including `/.well-known/oauth-protected-resource/mcp` | Resource metadata the connector fetches first |
| `/.well-known/oauth-authorization-server` | Authorization server metadata |
| `/oauth/register` | Dynamic client registration |
| `/oauth/token` | Token exchange and refresh |
| `/oauth/revoke` | Token revocation |

`/oauth/authorize` is **not** public. The consent page needs your owner login, so the remote MCP server advertises it on the tailnet origin. When you connect claude.ai or ChatGPT, the consent page opens in your own browser, and that browser's device must be on the tailnet. The connector's servers never load it; they only call the endpoints above.

Two layers enforce this:

1. **Tailscale** maps only these paths on a separate Funnel port. Port 443 stays tailnet-only `tailscale serve`.
2. **Postreeve** answers a bare 404 to any request carrying `Tailscale-Funnel-Request` for a path outside the list, and to encoded or backslash paths. It honors the header whether or not `POSTREEVE_TRUST_PROXY` is set, because the header can only narrow access. Tailscale sets that header on every Funnel request and deletes any copy a client sends, so the internet cannot forge or strip it. A missing Funnel path mapping therefore still cannot expose the UI.

Enable it (requires the `funnel` node attribute in your tailnet policy file):

```bash
for path in /mcp /.well-known/oauth-protected-resource /.well-known/oauth-authorization-server /oauth/register /oauth/token /oauth/revoke; do
  sudo tailscale funnel --bg --https=8443 --set-path="$path" "http://127.0.0.1:3000$path"
done
tailscale funnel status
# From a device outside the tailnet (phone on mobile data):
curl -s -o /dev/null -w '%{http_code}\n' https://<machine>.<tailnet>.ts.net:8443/.well-known/oauth-protected-resource/mcp   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://<machine>.<tailnet>.ts.net:8443/api/health                                 # 404
```

The connector URL is `https://<machine>.<tailnet>.ts.net:8443/mcp`. Turn Funnel off with `sudo tailscale funnel --https=8443 off`.

Risks you accept by enabling it:

- Anyone on the internet can call these paths. Their safety rests on the remote MCP server's OAuth (token validation, registration limits) and on the owner-login checks. Funnel traffic has no tailnet identity.
- A connector holds a token that can read your mail and prepare actions. Only the human UI can approve proposals, but reading is enough to leak mail. Revoke the connector's grant when you stop using it.
- The public origin is `https://<machine>.<tailnet>.ts.net:8443`, which differs from `POSTREEVE_PUBLIC_URL`. The remote MCP server's metadata and host checks must accept it.
- Your home machine receives internet traffic, including scanners.

## Same host as a mail server (poste.io, Stalwart)

Postreeve can share a VPS with poste.io (and later Stalwart) that publish `25/80/443/465/587/993` on `0.0.0.0`.

- **Port 443 does not conflict.** `tailscale serve` does not bind a host socket. Tailscale's netstack intercepts TCP to the machine's own Tailscale IP on serve ports before the kernel sees it (`wgengine/netstack`, `ShouldInterceptTCPPort`). Connections to the public IP on 443 still reach poste.io, and tailnet connections to `<machine>.<tailnet>.ts.net:443` reach Postreeve. As a side effect, poste.io's web UI is no longer reachable on the Tailscale IP's port 443; use its public hostname. Postreeve's own `127.0.0.1:3000` does not collide with the mail ports. Funnel traffic arrives over the tailnet, not on the public IP, so port 8443 does not conflict either. Check it after setup: from a tailnet device, `curl -sf https://<machine>.<tailnet>.ts.net/api/health` must return `{"ok":true}`, not a poste.io page.
- **Caveat:** `tailscaled` also opens a host listener on the Tailscale IP for connections the machine makes to itself, which skip netstack. That listener can collide with a process on `0.0.0.0:443`. The result is that only the VPS's own requests to the ts.net URL may fail, and `journalctl -u tailscaled` shows the listen error. Other tailnet devices are unaffected. This is read from Tailscale's source, not tested on a host running poste.io.
- **If tailnet devices get poste.io or a connection error on 443**, serve the app on another HTTPS port with `sudo tailscale serve --bg --https=8443 http://127.0.0.1:3000`. Then set `POSTREEVE_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8443`, and move Funnel to `--https=10000`.
- **Keep Postreeve on its own Docker network.** Compose already creates `postreeve_default`. Do not attach Postreeve to poste.io's network, and do not attach poste.io to Postreeve's. A compromise of one container should not reach the other's internal ports.
- **Connect to the mail server by its public hostname** (for example `mail.example.com`, IMAP 993 and SMTP 465/587), not by container name or `localhost`. That name matches poste.io's Let's Encrypt certificate, so TLS verification stays on, and the account keeps working if the mail server moves. From inside the container, the public hostname resolves to the VPS's public IP and Docker routes it back to the published ports. If your firewall blocks that hairpin, add `extra_hosts: ["mail.example.com:host-gateway"]` to the service in a `compose.override.yaml`; the name and certificate stay the same.
- **Back up off the machine.** On one VPS, losing the box loses the mail server and Postreeve together, so local snapshots are not enough. Copy `./backups` with restic or rclone to another provider (see [Off-machine copies](#off-machine-copies)), keep the master key outside the VPS, and consider Contabo's own snapshots as a second layer. Back up poste.io's data directory with the same tool.

## Appendix: native systemd service (optional)

For running without Docker, `deploy/systemd/postreeve.service` runs Postreeve as a `postreeve` user from `/opt/postreeve`. It binds `127.0.0.1:3000`, sets `POSTREEVE_TRUST_PROXY=1`, keeps data and snapshots in `/var/lib/postreeve` (its only writable path) and reads secrets from `/etc/postreeve/postreeve.env`.

```bash
curl -fsSL https://bun.sh/install | sudo env BUN_INSTALL=/usr/local bash
sudo useradd --system --home-dir /var/lib/postreeve --shell /usr/sbin/nologin postreeve
sudo git clone https://github.com/realDragonium/postreeve.git /opt/postreeve
cd /opt/postreeve && sudo bun install --frozen-lockfile && sudo bun run build
sudo install -d -m 700 /etc/postreeve
sudo sh -c 'umask 077; printf "POSTREEVE_MASTER_KEY=%s\nPOSTREEVE_SETUP_TOKEN=%s\nPOSTREEVE_PUBLIC_URL=https://<machine>.<tailnet>.ts.net\n" "$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > /etc/postreeve/postreeve.env'
sudo cp deploy/systemd/postreeve.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now postreeve
journalctl -u postreeve -f
```

Run backup commands as the service user with its paths: `sudo -u postreeve env POSTREEVE_DB_PATH=/var/lib/postreeve/postreeve.sqlite POSTREEVE_BACKUP_DIR=/var/lib/postreeve/backups bun run backup [restore <file>]`, stopping the service before a restore. `deploy/launchd/nl.dragonium.postreeve.plist` is an untested macOS equivalent.
