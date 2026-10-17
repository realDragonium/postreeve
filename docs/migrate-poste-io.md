# Migrating from poste.io to Stalwart

A runbook for moving the domains and mailboxes on the self-hosted poste.io (Contabo VPS) to Stalwart on the same host, using Postreeve to recreate everything and publish DNS. **Running it is your explicit, separate decision.** Nothing in this repository runs it, and every helper script only reads from poste.io.

Do the whole thing once with a secondary mailbox on a spare domain before moving the mailboxes you depend on. The Strato domain is not part of this; it stays an ordinary IMAP account in Postreeve.

## What changes and what does not

Stalwart takes over the same host, public IP and mail hostname (say `mail.example.org`), so:

- **MX records do not change**: they already point at `mail.example.org`.
- **SPF does not change** if it authorizes the host by `mx`, `a` or its IP. Postreeve's DNS plan proposes Stalwart's SPF value; keep yours if it already covers the host.
- **DKIM changes**: Stalwart signs with new keys and selectors. Old and new records coexist, so they are published before the window.
- **Passwords change**: poste.io's API does not export password hashes, so each mailbox gets a new password in Stalwart.
- **The cutover is one maintenance window** of about 15 minutes in which no server accepts mail. Senders queue and retry for days; nothing is lost.

poste.io and Stalwart cannot both bind 25, 465, 587, 993 and 4190 on one host, so Stalwart is staged with no public mail ports and takes them over inside the window. Caddy already owns 80/443 (`docs/self-host.md`) and keeps them throughout.

## 0. Prepare (days before)

1. Read `docs/stalwart.md`. Create the `mail-admin` network and start Stalwart in staging mode:
   ```bash
   docker network create --internal mail-admin
   cd deploy/stalwart && STALWART_RECOVERY_ADMIN="admin:$(openssl rand -base64 18)" docker compose -f compose.yaml -f compose.staging.yaml up -d
   ```
   Finish its setup, the Cloudflare DNS-01 certificate (this works now, while poste.io answers on 80/443) and the API key, then connect it in Postreeve as `http://stalwart:8080`.
2. Connect Cloudflare (and GoDaddy, if its API lets you) under **Mail server › DNS providers**.
3. Lower the TTL of the records you might touch (DKIM, `_dmarc`, `_mta-sts`, the mail host A/AAAA, MX) to 300 seconds, at least one old TTL before the window. Postreeve writes the records it publishes with a 300-second TTL (600 at GoDaddy, its minimum).
4. Back up poste.io's data volume (`docker inspect` shows its `/data` mount; copy it while the container is stopped, or snapshot the VPS).

## 1. Inventory

```bash
POSTE_PASSWORD='…' bun scripts/migration/poste-inventory.ts \
  --url https://mail.example.org --user admin@example.org --out ./migration \
  --add-to-postreeve you@example.org,other@example.org
```

It only reads (`GET /admin/api/v1/domains`, `/boxes`), writes `migration/inventory.json` and `migration/plan.json`, and prints the steps it cannot express (forward-and-keep boxes, disabled boxes, catch-alls with several targets). Compare the field names it expects (`address`, `name`, `redirect_to`, `redirect_only`, `storage_limit`, `disabled`) with your server's API docs at `https://mail.example.org/admin/api/doc`; add `--quota-unit bytes` if `storage_limit` is in bytes. Without API access, write `inventory.json` by hand in the same shape and use `--from inventory.json`.

`migration/` holds addresses and later passwords and is in `.gitignore`. Keep it on the VPS or your own machine.

## 2. Recreate domains and mailboxes in Stalwart

In Postreeve, **Settings › Mail server › Proposals › Import migration plan**, choose `migration/plan.json`. It becomes a pending proposal; nothing changes in Stalwart yet. Review the operations, enter a new password for each mailbox, approve. Write each new password into `migration/passwords/<address>.new` and the current poste.io password into `<address>.old` (`chmod 600`); imapsync reads them there. Handle the printed manual steps in Stalwart's admin (Sieve redirects for forward-and-keep boxes).

## 3. Publish the new DKIM records (still before the window)

For each domain, open its **DNS** tab in Postreeve. Tick only the new DKIM records (`v1-rsa-…._domainkey`, `v1-ed25519-…._domainkey`) and apply. Leave everything else for the window: MX, SPF and the rest still describe poste.io, which is serving mail. Wait until the checklist shows the DKIM rows as OK. For GoDaddy domains Postreeve cannot write, copy the values from the checklist.

## 4. Bulk copy (poste.io still live)

```bash
bun scripts/migration/imapsync-plan.ts --old mail.example.org --new localhost --new-port 1993 --new-self-signed > migration/sync.sh
sh migration/sync.sh          # dry run: lists folders and counts, copies nothing
bun scripts/migration/imapsync-plan.ts --old mail.example.org --new localhost --new-port 1993 --new-self-signed --live > migration/sync.sh
sh migration/sync.sh          # copies; safe to re-run, it only adds what is missing
```

`--new-self-signed` skips the certificate check for this loopback hop only (the certificate names `mail.example.org`, not `localhost`). imapsync never deletes on either side here. Large mailboxes take hours; poste.io keeps serving mail meanwhile. Re-run it the evening before the window to keep the final copy short.

## 5. The maintenance window (about 15 minutes)

1. Stop poste.io: `docker stop <poste container>`. Inbound mail now waits at the senders.
2. Start Stalwart with its public ports: `cd deploy/stalwart && docker compose up -d` (without the staging overlay).
3. Start poste.io again with **only** its IMAP port on loopback for the final copy, for example `docker run … -p 127.0.0.1:2993:993 …` with its original volume and no other ports.
4. Final incremental copy:
   ```bash
   bun scripts/migration/imapsync-plan.ts --old localhost --old-port 2993 --old-self-signed --new mail.example.org --live > migration/sync.sh
   sh migration/sync.sh
   ```
5. Stop the loopback-only poste.io container. Do not delete it or its volume.
6. Swap the poste.io `mail.<domain>` blocks in the Caddyfile for the Stalwart ones (`docs/self-host.md`, "Stalwart (after the cutover)") and reload Caddy.
7. In Postreeve, apply each domain's remaining DNS plan: DMARC, MTA-STS, TLS-RPT, autoconfig and SRV records are created; review the SPF update and any old MX before ticking them.

## 6. Verify

- Postreeve's DNS checklist: MX, SPF, DKIM and DMARC OK for every domain; the DNS plan shows no default changes.
- Send from a Stalwart mailbox to an outside address (Gmail): **Show original** shows SPF, DKIM and DMARC pass, with a Stalwart DKIM selector.
- Send from outside to each domain, including an alias and the catch-all, and check the right mailbox receives it.
- Compare folder message counts (`imapsync … --justfoldersizes` against both, or Postreeve's counts).
- Postreeve's queue view is empty or shows only expected deferrals.
- `https://mta-sts.<domain>/.well-known/mta-sts.txt` returns the policy through Caddy; `https://mail.<domain>/admin` returns 404 from the internet.
- Clients: in Postreeve use **Add to Postreeve** on each mailbox (it creates an app password), then remove the old poste.io account entries; phones get the new password or an app password from Stalwart's self-service.
- Over the next days, DMARC and TLS reports appear under **Reports**.

## 7. Clean up (a week later)

Remove poste.io's DKIM records (Postreeve did not create them, so remove them at the provider), raise TTLs back to normal, then archive and delete the poste.io container and volume once you are sure you will not roll back.

## Rollback

Until step 7:

1. `cd deploy/stalwart && docker compose down` (the volume stays).
2. Start poste.io with its original port mappings and put its `mail.<domain>` blocks back in the Caddyfile.
3. Copy mail Stalwart received since the window back with imapsync (Stalwart as `--host1`, poste.io as `--host2`).
4. DNS: MX and SPF never changed and poste.io's DKIM record is still published, so mail flows again. The extra records Postreeve created (Stalwart DKIM, MTA-STS, autoconfig) are harmless; remove the `_mta-sts` TXT record if poste.io does not serve a policy.
