# Self-hosting Postreeve

Postreeve runs in Docker Compose on a Linux VPS with a public IP, next to the mail server (poste.io now, Stalwart later). Traffic reaches the machine in two separate ways:

```
Tailnet devices ── tailscale serve :443 (Tailscale IP) ──► 127.0.0.1:3000   Postreeve UI + /api
Internet ──┬─ :25 :465 :587 :993 ─────────────────────────► mail server
           └─ Caddy :80 :443 ─┬─ mail.<domain> ───────────► mail server web (HTTP)
                              └─ mcp.<domain>  ───────────► 127.0.0.1:<POSTREEVE_PUBLIC_MCP_PORT>   agent endpoints only
```

- The web UI and `/api` are reachable only from your tailnet. Port 3000 is never forwarded to the internet.
- The public internet gets the mail ports and only the remote MCP endpoints on `https://mcp.<domain>`, through Caddy with Let's Encrypt.
- Every container port publishes on `127.0.0.1` only (see [Firewall](#firewall)).

The public agent listener (`POSTREEVE_PUBLIC_MCP_PORT`) is a second loopback-only port that serves only `/mcp`, `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`, and only for the `POSTREEVE_MCP_PUBLIC_URL` host. Everything else gets an empty 404, so a mistake in the Caddyfile cannot publish the UI. The consent page (`/oauth/authorize`) stays on the tailnet: approve a new agent from a device that is on Tailscale.

Behind Docker, Caddy's connections reach the container from the Docker gateway rather than loopback, so unauthenticated requests share one rate-limit bucket. Requests carrying an agent token are still limited per token. That is fine for a single owner.

## Settings

| Variable | Value |
| --- | --- |
| `POSTREEVE_MASTER_KEY` | 32 random bytes, base64. Encrypts stored mail credentials. |
| `POSTREEVE_PUBLIC_URL` | `https://<machine>.<tailnet>.ts.net`, the origin only, no path |
| `POSTREEVE_TRUST_PROXY` | `1`: trust `X-Forwarded-Proto` from the local proxy |
| `POSTREEVE_SETUP_TOKEN` | One-time token to claim the owner account on first run |
| `POSTREEVE_PUBLIC_MCP_PORT` | Port of the public agent listener inside the container, e.g. `3001`; off when unset. Compose publishes it on `127.0.0.1` only |
| `POSTREEVE_MCP_PUBLIC_URL` | `https://mcp.<domain>`; required when `POSTREEVE_PUBLIC_MCP_PORT` is set |
| `POSTREEVE_GOOGLE_CLIENT_ID`, `POSTREEVE_GOOGLE_CLIENT_SECRET` | Google OAuth client (optional) |
| `POSTREEVE_GOOGLE_REDIRECT` | `loopback` to force the loopback OAuth callback (see [Google accounts](#google-accounts)) |
| `POSTREEVE_BACKUP_INTERVAL_HOURS`, `POSTREEVE_BACKUP_KEEP` | Defaults `24` and `7` |
| `POSTREEVE_BACKUP_HOST_DIR` | Host directory for snapshots, default `./backups` |
| `POSTREEVE_HOST_PORT` | Host loopback port, default `3000` |
| `POSTREEVE_SHUTDOWN_TIMEOUT_MS` | Drain time on stop, default `20000` |

## 1. Tailscale on the VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # prints a login URL; approve the machine in your tailnet
tailscale status             # note the machine name
```

In the Tailscale admin console:
- **DNS → MagicDNS:** enable it. The VPS becomes `<machine>.<tailnet>.ts.net`.
- **DNS → HTTPS Certificates:** enable it, so `tailscale serve` can get a certificate.
- **Machines → the VPS → Disable key expiry**, so the server does not drop off the tailnet after the key lifetime.

Optional: `sudo tailscale set --ssh` and then reach SSH only over the tailnet (see [Firewall](#firewall)).

## 2. The master key

Losing `POSTREEVE_MASTER_KEY` or changing it makes every stored mailbox password and Google refresh token unrecoverable; you would have to add each account again. The key protects only those credentials, not the mail content in the database. Keep a copy in your password manager, off the VPS and separate from the backups.

`bun run setup:local` writes a new key into `.env` without printing it. Without Bun on the host, generate it straight into the file so only the command reaches shell history:

```bash
umask 077; printf 'POSTREEVE_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

Copy it into your password manager by opening `.env` in an editor, not by `cat`-ing it into terminal scrollback.

## 3. Start Postreeve

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

Compose reads `.env` only to fill in the variables named in `compose.yaml`; the other local-development lines in it do not reach the container. Compose publishes only `127.0.0.1:3000` and runs Postreeve on its own `postreeve_default` network, keeps the database in the `postreeve-data` volume, writes snapshots to `./backups`, restarts unless stopped, and gives the server 30 seconds to drain on stop. The container starts as root only to give the `bun` user its data and backup directories, then drops to `bun`.

## 4. The UI on the tailnet with `tailscale serve`

```bash
sudo tailscale serve --bg http://127.0.0.1:3000
tailscale serve status         # https://<machine>.<tailnet>.ts.net -> http://127.0.0.1:3000
# From another tailnet device:
curl -sf https://<machine>.<tailnet>.ts.net/api/health   # {"ok":true}, not a Caddy or poste.io page
```

This is a secure context, so passkeys (WebAuthn) work. The configuration survives reboots; remove it with `sudo tailscale serve --https=443 off`.

**Port 443 is shared with Caddy without conflict.** `tailscale serve` does not bind a host socket for tailnet traffic. Tailscale's netstack intercepts TCP to the machine's own Tailscale IP on serve ports before the kernel sees it (`wgengine/netstack`, `ShouldInterceptTCPPort`), so tailnet connections to 443 reach Postreeve and connections to the public IP on 443 reach Caddy. One caveat, from reading Tailscale's source and not tested on this host: `tailscaled` also opens a host listener on the Tailscale IP for the VPS's connections to itself, and that can collide with Caddy on `0.0.0.0:443`. Only requests from the VPS to its own ts.net URL would fail, and `journalctl -u tailscaled` shows the error. If tailnet devices get Caddy's page or an error instead of `{"ok":true}`, serve on another port: `sudo tailscale serve --bg --https=8443 http://127.0.0.1:3000` and set `POSTREEVE_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8443`.

What `tailscale serve` sends to Postreeve (from `ipn/ipnlocal/serve.go`): the original `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto: https`, `Tailscale-User-Login`/`Tailscale-User-Name`, and `X-Forwarded-For`. Go's `ReverseProxy` deletes any client-sent `X-Forwarded-*` before Tailscale **sets** `X-Forwarded-For` to exactly one address, the tailnet peer's IP.

The certificate comes from Let's Encrypt, so the machine and tailnet names appear in public Certificate Transparency logs. That alone does not make the UI reachable from the internet.

## 5. Caddy as the public TLS front

Caddy owns ports 80 and 443 on the public IP and gets Let's Encrypt certificates for each name. Install it from the official repository:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Point DNS `A`/`AAAA` records for `mail.<domain>` and `mcp.<domain>` at the VPS. Then `/etc/caddy/Caddyfile`, with poste.io moved behind Caddy as in the next section:

```caddyfile
{
	email postmaster@<domain>
}

# poste.io webmail and admin. poste.io keeps its own Let's Encrypt certificate for IMAP/SMTP and renews it with
# HTTP-01, so Caddy passes ACME challenges for this name through and proves its own certificate with TLS-ALPN-01.
mail.<domain> {
	tls {
		issuer acme {
			disable_http_challenge
		}
	}
	reverse_proxy 127.0.0.1:8080
}

http://mail.<domain> {
	handle /.well-known/acme-challenge/* {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		redir https://{host}{uri} permanent
	}
}

# Remote MCP: the public agent listener (POSTREEVE_PUBLIC_MCP_PORT=3001).
mcp.<domain> {
	reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
journalctl -u caddy -f        # watch the certificates being issued
```

Caddy keeps the original `Host` on proxied requests and adds `X-Forwarded-Proto` and `X-Forwarded-Host`.

**`X-Forwarded-For` behind Caddy.** Since Caddy 2.5 no proxy is trusted by default. Caddy ignores any `X-Forwarded-*` a client sends and sets `X-Forwarded-For` to the address it sees on the socket. Behind this Caddyfile, the last (and only) `X-Forwarded-For` entry is the real client IP, which is what the remote MCP server rate-limits on. If you ever put a CDN in front of Caddy, set `trusted_proxies` to that CDN's ranges, never to `0.0.0.0/0`, or the client IP becomes forgeable.

## 6. Mail server behind Caddy

### poste.io (now)

poste.io holds 80 and 443 today. Move its web ports to loopback and let Caddy terminate TLS:

- `HTTPS=OFF` disables poste.io's redirect to HTTPS (Caddy does TLS).
- `HTTP_PORT=8080` and `HTTPS_PORT=8443` move its web listeners off 80/443.
- Keep publishing the mail ports (25, 465, 587, 993) publicly; they never go through Caddy.
- poste.io's own Let's Encrypt certificate for IMAP/SMTP still renews through `/.well-known/acme-challenge/` on port 80, which the Caddyfile above forwards to it.

If poste.io runs with bridge networking, publish the web port on loopback only: `-p 127.0.0.1:8080:8080` (and drop `-p 80:80 -p 443:443`). If it runs with `--net=host`, its web ports bind `0.0.0.0`; ufw blocks 8080/8443 from the internet there because host-network processes do not get Docker's firewall bypass. Restart poste.io, then Caddy. Check that `https://mail.<domain>` serves webmail with Caddy's certificate and that `openssl s_client -connect mail.<domain>:993` still shows poste.io's certificate.

poste.io's admin UI (`/admin`) stays as reachable as it is today. To make it tailnet-only, add `@admin path /admin /admin/*` with `respond @admin 404` to the `mail.<domain>` block and reach the admin with `sudo tailscale serve --bg --https=10443 http://127.0.0.1:8080`.

Verify the poste.io variable names against its documentation for your image version before you restart it.

### Stalwart (after the cutover)

`feat/stalwart-admin` writes the Stalwart Compose file. It must publish Stalwart's HTTP listener on `127.0.0.1` only. In Caddy, only the public mail routes are forwarded to it, and the admin UI is reachable only through `tailscale serve`:

```caddyfile
mail.<domain> {
	@public path /.well-known/jmap /jmap /jmap/* /.well-known/autoconfig/* /autodiscover/* /mail/config-v1.1.xml
	handle @public {
		reverse_proxy 127.0.0.1:<stalwart-http-port>
	}
	handle {
		respond 404
	}
}
autoconfig.<domain>, autodiscover.<domain> {
	reverse_proxy 127.0.0.1:<stalwart-http-port>
}
mta-sts.<domain> {
	@policy path /.well-known/mta-sts.txt
	handle @policy {
		reverse_proxy 127.0.0.1:<stalwart-http-port>
	}
	handle {
		respond 404
	}
}
```

The exact paths and port come from `feat/stalwart-admin`. Stalwart's certificate for IMAP/SMTP needs the same arrangement as poste.io's: forward its ACME HTTP-01 path through Caddy, or point Stalwart at Caddy's certificate files.

## Firewall

Allow only SSH, the web front and the mail ports from the internet:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                       # first, so enabling ufw cannot lock you out
sudo ufw allow 80,443/tcp                   # Caddy
sudo ufw allow 25,465,587,993/tcp           # mail
sudo ufw allow 41641/udp                    # Tailscale direct connections (optional; it falls back to relays)
sudo ufw allow in on tailscale0             # everything from your tailnet
sudo ufw enable && sudo ufw status verbose
```

Once `ssh <machine>` works over the tailnet, run `sudo ufw delete allow 22/tcp` so SSH is reachable only through Tailscale. Mirror the same rules in Contabo's firewall panel if you use it, as a second layer.

**Docker-published ports bypass ufw.** Docker adds its own iptables rules that run before ufw's, so `ports: ["3000:3000"]` would be reachable from the internet even with ufw denying 3000. Every Postreeve, Stalwart and mail-admin port must publish as `127.0.0.1:<port>:<port>`. Postreeve's `compose.yaml` already does. Only the mail ports themselves, which are meant to be public, may publish on all interfaces. Check from outside the VPS with `nmap -Pn <public IP>`: only 22 (until removed), 25, 80, 443, 465, 587 and 993 should be open.

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
3. Connect each Google account from a browser that reaches the server as `127.0.0.1:3000`, through an SSH tunnel:

   ```bash
   ssh -N -L 3000:127.0.0.1:3000 <machine>
   # then open http://127.0.0.1:3000 locally and choose Continue with Google
   ```

The stored refresh token then works from the ts.net URL too. Repeat the tunnel only to add or reauthorize a Google account.

## Mail accounts on the same host

Add your own domain's mailbox in Postreeve by its public hostname, `mail.<domain>`, with IMAP 993 and SMTP 465 or 587. Do not use a container name, `localhost` or the Docker network: the public name matches the mail server's Let's Encrypt certificate, so TLS verification stays on, and the account keeps working when poste.io is replaced by Stalwart or the server moves.

From inside the Postreeve container, `mail.<domain>` resolves to the VPS's public IP, and Docker routes the connection back to the published mail ports. If that hairpin is blocked, create `compose.override.yaml` with `services: { postreeve: { extra_hosts: ["mail.<domain>:host-gateway"] } }`. The name and certificate stay the same.

Do not attach Postreeve to the mail server's Docker network or the other way round. A compromise of one container should not reach the other's internal ports.

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

### Off-machine copies (required on a single VPS)

Postreeve and the mail server share one machine, so losing the VPS loses both. Local snapshots only cover bad updates and mistakes. Copy `./backups` to another provider with an encrypting tool, for example from a daily cron job, and back up the mail server's data directory the same way:

```bash
# restic: encrypted, deduplicated
restic -r sftp:backup-host:/srv/restic/postreeve backup ./backups
# rclone to an encrypted "crypt" remote
rclone copy ./backups secret-remote:postreeve --include 'postreeve-*.sqlite'
```

Copy only finished `postreeve-*.sqlite` files, never the live volume. Contabo's own VPS snapshots are a useful second layer, not a replacement. To restore from off-machine, put one snapshot back into `./backups` and follow the restore steps.

## Rotating secrets

- **Setup token:** used only to claim the owner account. After claiming, remove it from `.env` and run `docker compose up -d`.
- **Google client secret:** create a new secret in Cloud Console, update `.env`, run `docker compose up -d`, then delete the old secret. Stored refresh tokens stay valid for the same client ID.
- **Master key:** Postreeve cannot re-encrypt credentials under a new key yet. Changing it means removing and re-adding every account, so rotate it only if it leaked.
- **Mailbox passwords:** change the app password at the provider, then update the account in Postreeve.

## Logs

```bash
docker compose logs -f postreeve
journalctl -u caddy -f
journalctl -u tailscaled -f
```

Postreeve logs `Postreeve listening on http://0.0.0.0:3000` at start, one line per backup, and `Postreeve is shutting down` / `Postreeve stopped` on stop. On SIGTERM it stops accepting requests, ends open event streams, waits for in-flight requests and the running synchronization pass (IMAP IDLE connections close), then closes the database. After `POSTREEVE_SHUTDOWN_TIMEOUT_MS` it closes remaining connections.

## Remote MCP connectors

Cloud MCP connectors (claude.ai, ChatGPT) reach `https://mcp.<domain>/mcp` through Caddy. That listener serves only the paths in `PUBLIC_PATHS` (`src/server/runtime/public-listener.ts`): `/mcp`, `/.well-known/oauth-protected-resource` and its sub-paths, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`. Everything else gets a bare 404.

`/oauth/authorize` is not public. The consent page needs your owner login, so it is advertised on the ts.net origin. When you connect a connector, the consent page opens in your own browser, and that device must be on the tailnet. The connector's servers only call the public endpoints.

Risks you accept by adding the `mcp.<domain>` block:
- Anyone on the internet can call those paths. Their safety rests on the remote MCP server's OAuth (token validation, registration limits, rate limits) and on the owner-login checks.
- A connector holds a token that can read your mail and prepare actions. Only the human UI can approve proposals, but reading is enough to leak mail. Revoke the connector's grant when you stop using it.

Tailscale Funnel is not used in this layout: with a public IP and Caddy it adds nothing.

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
