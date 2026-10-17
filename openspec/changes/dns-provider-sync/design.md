# Design

## Context

See proposal.md. The Stalwart admin change (archived `2026-10-17-stalwart-mail-server-admin`) gives each domain a checklist parsed from Stalwart's own zone output. The owner's host layout (coordinator, owner-approved): one Contabo VPS with poste.io now and Stalwart later, Postreeve, Caddy on 80/443 routing by hostname, Stalwart admin tailnet-only. DNS: Cloudflare for most domains, GoDaddy for some, Strato out of scope.

## Goals / Non-Goals

**Goals:** publish the checklist at Cloudflare and GoDaddy with a reviewable diff; never surprise the owner by changing records Postreeve did not create; keep working (copyable values) when a provider refuses API access.

**Non-Goals:** other providers; managing non-mail records; Stalwart's own automatic DNS publishing (left off on purpose, see 4); CAA and TLSA records (shown in the checklist, published by hand).

## Decisions

1. **Provider clients behind one record model.** Records are `{ type, name, value }` with `name` an absolute lowercase name without the trailing dot and `value` in presentation form (`10 mail.example.org` for MX, `0 1 993 mail.example.org` for SRV, raw text for TXT, a host for CNAME). Cloudflare maps one record to one API object with an id; GoDaddy has no record ids and works on type-plus-name sets, so its client reads the set, edits it and replaces it with `PUT /v1/domains/{domain}/records/{type}/{name}`. Postreeve marks records it creates at Cloudflare with the comment `Managed by Postreeve`; GoDaddy has no comment field.

2. **Ownership is Postreeve's own ledger.** Table `dns_owned_records` (migration `910002`) stores provider, zone, type, name and value of each record Postreeve created. That ledger, not the Cloudflare comment, decides what is "created by Postreeve", because comments can be edited by anyone with zone access and GoDaddy has none. Updating a foreign record does not adopt it.

3. **Planner rules (pure function, tested without network).**
   - A required record with an identical record present: in sync.
   - TXT records are matched by kind within a name: SPF (`v=spf1`), DMARC, DKIM, MTA-STS, TLS-RPT and the `v=UAAC1` autoconfig record. A required TXT with a same-kind record of another value is an **update** of that record; another TXT at the name (for example a site verification) is untouched.
   - CNAME and SRV at a name: an update of the existing one.
   - MX at a name: MX records are a set, so a missing required MX is a **create**, and every other MX at that name is a **conflict delete** (the owner wants all mail at Stalwart after cutover).
   - Extra same-kind TXT records (a second SPF) are conflict deletes.
   - Records in the ledger that are no longer required are stale deletes.
   - Default selection: creates, and updates and deletes of ledger records. Everything that touches a foreign record starts unselected. This is the "never delete records Postreeve did not create unless ticked individually" rule, extended to updates, because overwriting someone else's SPF is as surprising as deleting it.

4. **Fingerprint guard.** The plan's fingerprint is a SHA-256 over the provider's current records for the names involved plus the required records. Apply recomputes the plan and refuses with 409 if the fingerprint differs, so the owner always applies what they saw. Changes are identified by a hash of their content; the owner's selection is a list of those ids.

5. **Approval boundary.** Plan and apply routes live under `/api/mail-servers/...`, behind the owner guard and same-origin check. Agents get the proposal operation `applyDnsChanges { domain }`; approving it computes the plan at that moment and applies only the default selection. Agents cannot select foreign changes.

6. **GoDaddy 403.** GoDaddy limited its production DNS API in 2024 to accounts meeting its conditions (such as owning enough domains or a paid plan). Any 403 from GoDaddy becomes `status: "unavailable"` with that explanation, and the DNS tab keeps the copyable checklist. Connecting still succeeds when `GET /v1/domains` works but records are refused, so the owner sees the reason per domain. GoDaddy's field names and SRV shape follow its public v1 docs and were not verified against a live account; the fake follows the same docs.

7. **TTL.** New and updated records use 300 seconds. That suits the migration window; the owner can raise TTLs later at the provider.

### Host layout decisions (docs)

8. **Stalwart's certificate: Stalwart's own ACME client with Cloudflare DNS-01, not Caddy's certificates.** DNS-01 works before the cutover while poste.io still answers on 80/443 behind Caddy, needs no file sharing between Caddy's data directory and Stalwart's UID 2000, renews inside Stalwart without restarts, and avoids routing `/.well-known/acme-challenge` for the mail host through Caddy (which would clash with Caddy's own HTTP-01 for the same name). Stalwart's DNS-01 requires the domain's DNS management set to automatic with a DNS server; with an empty `publishRecords` set it uses the provider only for challenges (verified in Stalwart's source, `common/src/network/dns/records.rs`), so Postreeve stays the only writer of mail records. Stalwart gets its own Cloudflare token scoped to the mail host's zone.

9. **Public HTTP paths: autoconfig, autodiscover and MTA-STS only; JMAP stays private.** Stalwart serves its management API on `/jmap`, the same path as mail JMAP, so publishing `/jmap` would put the admin API on the internet behind only a password. Postreeve and phones use IMAP and SMTP, so nothing the owner uses needs public JMAP. The Caddyfile routes `/.well-known/autoconfig/*`, `/mail/config-v1.1.xml`, `/autodiscover/*` and `/.well-known/mta-sts.txt` and answers 404 elsewhere.

10. **How Postreeve reaches the admin API.** Postreeve runs in Docker (bridge network), so the host's `127.0.0.1:8080` is not loopback inside its container. Both compose projects join one external Docker network `mail-admin` marked `internal: true`; Postreeve connects to `http://stalwart:8080` (a single-label private name, which the admin URL policy already allows over HTTP). The owner's browser reaches Stalwart's admin through `tailscale serve --https=8443` on the host's `127.0.0.1:8080`. No admin port is published on a public interface, so Docker's ufw bypass does not matter.

11. **Cutover: one maintenance window on the same host.** Stalwart is staged with its mail ports unpublished (IMAP on `127.0.0.1:1993` for the copy) while poste.io serves mail; principals come from the inventory proposal; DKIM records are published through this change before the window; inside the window poste.io stops, Stalwart publishes 25/465/587/993/4190, a final incremental imapsync runs from poste.io on a loopback port, and Postreeve applies the remaining DNS plan. Rollback: stop Stalwart, start poste.io; DNS needs nothing because poste.io's DKIM record is kept.

## Risks / Trade-offs

- [GoDaddy API details unverified] → Fake built from public docs; 403 path tested; GoDaddy plans degrade to the checklist.
- [A Cloudflare token with Zone:DNS:Edit can change any record in its zones] → Recommend scoping it to the mail domains' zones only; Postreeve never touches names outside the checklist; foreign changes need ticks.
- [Plans go stale between agent proposal and approval] → Approval recomputes the plan and applies only default-selected changes.
