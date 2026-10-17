# Running Stalwart next to Postreeve

This guide sets up [Stalwart Mail Server](https://stalw.art) **v0.16.26** on the same VPS as Postreeve and Caddy, in its own Docker Compose project, and connects it to Postreeve's **Settings › Mail server** area. The host layout (Tailscale, Caddy on 80/443, firewall) is in `docs/self-host.md`; moving off poste.io is `docs/migrate-poste-io.md`.

## What is public and what is not

| Port | Purpose | Reachable from |
| --- | --- | --- |
| 25 | SMTP: mail from other servers | Internet |
| 465 | Submission, implicit TLS (Postreeve uses this) | Internet |
| 587 | Submission, STARTTLS (phones and older clients) | Internet |
| 993 | IMAP, implicit TLS | Internet |
| 4190 | ManageSieve (filter rules) | Internet |
| 443 via Caddy | Autoconfig, autodiscover, MTA-STS policy only | Internet |
| `127.0.0.1:8081` | Web admin, management API (`/jmap`), the paths above | Caddy; your tailnet via `tailscale serve`; Postreeve via the `mail-admin` network |

Stalwart serves its management API on `/jmap`, the same path as mail JMAP. Caddy therefore forwards only the autoconfig, autodiscover and MTA-STS paths and answers 404 for `/jmap`, `/admin` and `/api`. Nothing the owner uses needs public JMAP: Postreeve and phones use IMAP and SMTP.

## Before you start

- A DNS name for the mail host, for example `mail.example.org`, with A (and AAAA if you have IPv6) records pointing at the VPS. Reverse DNS (PTR) for the VPS address set to that name in the Contabo panel.
- Outbound port 25 open at the provider: `nc -vz gmail-smtp-in.l.google.com 25` from the VPS.
- Caddy and Tailscale as in `docs/self-host.md`.
- The private network both projects share: `docker network create --internal mail-admin`.
- While poste.io runs, Stalwart starts in staging mode (`compose.staging.yaml`) without public mail ports: see the migration guide.

## First start

```bash
cd deploy/stalwart
STALWART_RECOVERY_ADMIN="admin:$(openssl rand -base64 18)" \
  docker compose -f compose.yaml -f compose.staging.yaml up -d      # staging until the cutover; drop the overlay after
docker compose logs -f stalwart      # "Server started in bootstrap mode"
```

Open the setup page through the tailnet (`sudo tailscale serve --bg --https=8443 http://127.0.0.1:8081`, then `https://<vps>.<tailnet>.ts.net:8443/admin`), sign in as `admin` with the password you set, and complete setup:

- Server hostname `mail.example.org`, default domain `example.org`.
- Keep the stores on their defaults (RocksDB in the `stalwart-data` volume).
- Turn **off** "Request TLS certificate" for now (DNS-01 is set up below). Keep "Generate DKIM keys" on.

Store the administrator address and password it returns in your password manager, then restart without the recovery variable (`docker compose … up -d --force-recreate`).

## TLS certificates: Stalwart's ACME with Cloudflare DNS-01

Stalwart obtains and renews the certificate for `mail.example.org` itself, proving control through a TXT record at Cloudflare. This works before the cutover while poste.io still answers on 80/443, and needs no files shared with Caddy.

1. At Cloudflare, create an API token for Stalwart: **My Profile › API Tokens › Create Token**, permission **Zone › DNS › Edit**, zone resources limited to the zone of the mail host. This is a separate token from the one Postreeve uses.
2. In Stalwart's admin, add a DNS server of type Cloudflare with that token.
3. **Settings › TLS › ACME Providers:** add Let's Encrypt with challenge type DNS-01 and your contact address.
4. **Management › Domains ›** the domain that holds the mail host: set DNS management to *Automatic* with that DNS server and **no record types selected to publish**, then set certificate management to *Automatic* with the ACME provider, adding `mail.example.org` as a subject alternative name if it is not the domain itself.

With no record types selected, Stalwart uses Cloudflare only for the ACME challenge (`common/src/network/dns/records.rs` publishes only the selected types); Postreeve stays the one place that publishes mail records. Check **Settings › TLS › Certificates** for the issued certificate and its names.

## Listeners and the API key

In Stalwart's admin:

1. **Settings › Network › Listeners:** add `submission`: protocol SMTP, bind `[::]:587`, TLS on, implicit TLS off. Delete `pop3s` and `https` (Caddy does public HTTPS).
2. **Account › Credentials › API Keys** (signed in as the admin): create a key named `Postreeve`. Copy it once.

## Connect Postreeve

Start Postreeve on the shared network (from the repository root):

```bash
docker compose -f compose.yaml -f deploy/stalwart/postreeve-mail-admin.yaml up -d
```

Then in Postreeve, **Settings › Mail server › Connect a server**:

- Admin URL `http://stalwart:8080`. Postreeve allows plain HTTP only for loopback, private-network names like this one, and Tailscale addresses; the `mail-admin` network has no route to the internet.
- Credential: the API key. (The admin login works too, but a key can be revoked in Stalwart without changing the password.)
- Mail hostname `mail.example.org`: Postreeve uses it for IMAP 993 and SMTP 465 when it adds a mailbox as an account. It must match the certificate; an IP address is refused.

## Publish DNS records from Postreeve

**Mail server › DNS providers › Connect a DNS provider:**

- Cloudflare: an API token with **Zone › DNS › Edit**, limited to the zones of your mail domains.
- GoDaddy: a production API key and secret from developer.godaddy.com. GoDaddy limits its DNS API to some accounts; if it refuses, Postreeve says so and the DNS tab keeps the values to copy by hand.

Each domain's **DNS** tab then shows the changes needed (create, update, delete per record). Creates and changes to records Postreeve created are ticked; anything that touches a record Postreeve did not create (an old MX, a second SPF) starts unticked and changes only when you tick it. Nothing is written until you confirm, and if the zone changed since you looked, Postreeve asks you to review again. CAA and TLSA records, and SRV records at GoDaddy, stay in the checklist to copy.

## What Postreeve manages, and what stays in Stalwart's admin

Postreeve: domains, mailboxes (display name, quota, password reset, aliases), catch-all, mailing lists, DKIM keys, DNS checklist and provider sync, the delivery queue, received DMARC/TLS reports, spam switch, thresholds and sender lists, app-password-based Postreeve accounts.

Stalwart's admin: listeners, certificates and ACME, spam rules and training, routing and throttles, Sieve system scripts, storage, directories, groups, tenants and roles, logs and traces.

## Backups and upgrades

- Data lives in the `stalwart-data` volume. For a consistent copy: `docker compose stop stalwart`, then `docker run --rm -v stalwart_stalwart-data:/data -v "$PWD":/backup alpine tar czf /backup/stalwart-data.tgz -C /data .`, then `docker compose start stalwart`.
- Upgrades: change the pinned tag after reading Stalwart's `UPGRADING/` notes. Postreeve targets the v0.16 JMAP management API; check a new version first with `bun scripts/stalwart-test-instance.ts` and `tests/stalwart-live.test.ts`.
