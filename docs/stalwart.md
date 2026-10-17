# Running Stalwart next to Postreeve

This guide sets up [Stalwart Mail Server](https://stalw.art) **v0.16.26** on the same VPS as Postreeve, in its own Docker Compose project, and connects it to Postreeve's **Settings › Mail server** area. Postreeve itself runs as described in `docs/self-host-tailscale.md`.

Moving existing mail off poste.io is a separate, later step: `docs/migrate-poste-io.md`.

## What is public and what is not

| Port | Purpose | Reachable from |
| --- | --- | --- |
| 25 | SMTP: mail from other servers | Internet |
| 465 | Submission, implicit TLS (Postreeve uses this) | Internet |
| 587 | Submission, STARTTLS (phones and older clients) | Internet |
| 993 | IMAP, implicit TLS | Internet |
| 4190 | ManageSieve (filter rules) | Internet |
| 8080 | Web admin, JMAP, management API | `127.0.0.1` only; your tailnet through `tailscale serve` |

Ports 443, 110 and 995 are not published. That keeps Stalwart's web admin and management API off the internet, which is the point of this layout. The cost:

- **MTA-STS policy:** other servers fetch `https://mta-sts.<domain>/.well-known/mta-sts.txt`. With 443 closed they cannot, so do not publish the `_mta-sts` TXT record yet (Postreeve's DNS checklist will show it as missing; that is expected). Publish TLS-RPT anyway. If you want MTA-STS later, serve the policy file from any static HTTPS host for `mta-sts.<domain>`.
- **Autoconfig/autodiscover:** mail apps cannot discover settings automatically. Enter `mail.<domain>`, IMAP 993 and SMTP 465 by hand; Postreeve's one-step account does this for you.
- **JMAP, CalDAV, CardDAV from outside the tailnet:** not available.

Stalwart v0.16 has an `allowedEndpoints` expression on its HTTP settings that could block admin paths on a public 443 listener. In testing against v0.16.26 it had no visible effect after a settings reload, so this guide does not rely on it.

## Before you start

- A DNS name for the mail host, for example `mail.example.org`, with A (and AAAA if you have IPv6) records pointing at the VPS's public address.
- Reverse DNS (PTR) for the VPS address set to that same name in the Contabo control panel. Many receivers reject mail from an address whose PTR does not match the HELO name.
- Outbound port 25 open at the provider. Check with `nc -vz gmail-smtp-in.l.google.com 25` from the VPS.
- Tailscale running on the VPS with MagicDNS and HTTPS certificates enabled.
- Nothing else bound to 25, 465, 587, 993, 4190 or 8080 on the host. **poste.io binds most of these**: see the cutover in the migration guide before starting Stalwart for real.

## TLS certificates

Stalwart's built-in ACME client needs either public 443 (TLS-ALPN-01, its default) or port 80 on its HTTP listener, which would expose the admin. Use certbot on the host instead and hand Stalwart the files:

```bash
sudo apt install certbot
# Port 80 must be free and open for the HTTP-01 check; nothing else needs it on this host.
sudo certbot certonly --standalone -d mail.example.org --agree-tos -m you@example.org --no-eff-email
sudo install -m 755 deploy/stalwart/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/stalwart.sh
sudo RENEWED_LINEAGE=/etc/letsencrypt/live/mail.example.org /etc/letsencrypt/renewal-hooks/deploy/stalwart.sh || true
```

The hook copies `fullchain.pem` and `privkey.pem` to `/srv/stalwart-certs`, owned by UID 2000 (the user Stalwart's container runs as), and restarts Stalwart after each renewal. The first run fails at the restart step because Stalwart is not running yet; that is fine.

If your DNS host has an API Stalwart supports, DNS-01 through Stalwart's own ACME client is the alternative; configure it in Stalwart's admin under Settings › TLS › ACME Providers.

## First start

```bash
cd deploy/stalwart
STALWART_RECOVERY_ADMIN="admin:$(openssl rand -base64 18)" docker compose up -d   # note the password you set
docker compose logs -f stalwart      # "Server started in bootstrap mode"
```

Open the setup page through an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 vps`, then `http://127.0.0.1:8080/admin`) or through the tailnet (next section), sign in as `admin` with that password and complete the setup:

- Server hostname `mail.example.org`, default domain `example.org`.
- Leave the data, blob, search and in-memory stores on their defaults (RocksDB in `/var/lib/stalwart`, the `stalwart-data` volume).
- Turn **off** "Request TLS certificate" (certbot provides it). Keep "Generate DKIM keys" on.

The setup returns the real administrator address and password. Store them in your password manager, then restart without the recovery variable:

```bash
docker compose up -d --force-recreate   # STALWART_RECOVERY_ADMIN is now empty
```

Then, in Stalwart's admin:

1. **Settings › TLS › Certificates:** add a certificate whose certificate and private key are read from the files `/certs/fullchain.pem` and `/certs/privkey.pem`.
2. **Settings › Network › Listeners:** add a `submission` listener: protocol SMTP, bind `[::]:587`, TLS on, implicit TLS off. Delete the `pop3s` and `https` listeners if you will not use them.
3. **Account › Credentials › API Keys** (signed in as the admin): create a key named `Postreeve`. Copy it once; Stalwart does not show it again.

## The admin on your tailnet

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080
tailscale serve status    # https://<vps>.<tailnet>.ts.net:8443 -> http://127.0.0.1:8080
```

Stalwart's admin is now at `https://<vps>.<tailnet>.ts.net:8443/admin` for devices in your tailnet only. Port 443 on the tailnet stays free for Postreeve's own `tailscale serve`.

## Connect Postreeve

In Postreeve, **Settings › Mail server › Connect a server**:

- Admin URL: `https://<vps>.<tailnet>.ts.net:8443`. (Postreeve accepts plain `http://` only for loopback, private and Tailscale addresses, so `http://100.x.y.z:8080` from another tailnet machine also works if you publish 8080 on the Tailscale address instead.)
- Credential: the API key. The admin username and password work too, but a key can be revoked without changing the password.
- Mail hostname: `mail.example.org`. Postreeve uses it for IMAP 993 and SMTP 465 when it adds a mailbox as an account. It must be a name on the certificate, not an IP address.

If Postreeve runs in Docker on the same host, its container must resolve and reach the `ts.net` name. With MagicDNS on the host this normally works; check with `docker compose exec postreeve wget -qO- https://<vps>.<tailnet>.ts.net:8443/jmap/session` (expect a 401, which proves it is reachable).

Postreeve stores the key in its encrypted credential vault (`POSTREEVE_MASTER_KEY`). To cut Postreeve off, revoke the key in Stalwart.

## What Postreeve manages, and what stays in Stalwart's admin

Postreeve: domains, mailboxes (display name, quota, password reset, aliases), catch-all, mailing lists, DKIM keys, the per-domain DNS checklist, the delivery queue, received DMARC/TLS reports, the spam filter switch and score thresholds, trusted and blocked sender domains, and app-password-based Postreeve accounts for new mailboxes.

Stalwart's admin: listeners and ports, certificates and ACME, automatic DNS providers, spam rules and training, MTA routing and throttles, Sieve system scripts, storage, directories (LDAP/OIDC), groups, tenants and roles, logs and traces. Postreeve links to it from the server header.

## Backups and upgrades

- Data lives in the `stalwart-data` volume. For a consistent copy: `docker compose stop stalwart`, then `docker run --rm -v stalwart_stalwart-data:/data -v "$PWD":/backup alpine tar czf /backup/stalwart-data.tgz -C /data .`, then `docker compose start stalwart`.
- Upgrades: change the pinned tag in `compose.yaml` after reading Stalwart's `UPGRADING/` notes for that version. Postreeve's admin area targets the v0.16 JMAP management API; a 1.0 upgrade may need Postreeve changes first, and the live test (`bun scripts/stalwart-test-instance.ts`, then `tests/stalwart-live.test.ts`) is the way to check.
