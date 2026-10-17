# Migrating from poste.io to Stalwart

A runbook for moving the domains and mailboxes on the self-hosted poste.io (Contabo VPS) to Stalwart on the same host, using Postreeve to recreate everything. **Running it is your explicit, separate decision.** Nothing in this repository runs it, and every helper script is read-only towards poste.io.

Do the whole thing once with a secondary mailbox on a spare domain before moving the mailboxes you depend on.

## What changes and what does not

Stalwart takes over the same host, public IP and mail hostname (say `mail.example.org`). So:

- **MX records do not change**: they already point at `mail.example.org`.
- **SPF does not change** if it authorizes the host by `mx`, `a` or its IP.
- **DKIM changes**: Stalwart signs with new keys and new selectors. Both old and new records can be published at the same time, so this is done before the cutover.
- **Passwords change**: poste.io's password hashes are not exported by its API. Each mailbox gets a new password in Stalwart. (Stalwart accepts crypt-style password hashes, so copying hashes out of poste.io's database is possible in principle; this runbook does not cover it because poste.io's storage format was not verified.)
- The cutover itself is a few minutes in which neither server accepts mail. Sending servers queue and retry for days, so no mail is lost.

## 0. Prepare (days before)

1. Read `docs/stalwart.md`. Get the certificate for the mail hostname ready (certbot); poste.io currently holds ports 80/443, so issue it with `--standalone` during the cutover window or with a DNS challenge now.
2. Lower the TTL of every record you might touch (DKIM TXT, `_dmarc`, `_mta-sts`, the mail host A/AAAA, MX) to 300 seconds, at least one old TTL before the cutover (usually 1 to 2 days).
3. Back up poste.io's data volume (`docker inspect` shows its `/data` mount; copy it while the container is stopped, or snapshot the VPS).

## 1. Inventory

```bash
POSTE_PASSWORD='…' bun scripts/migration/poste-inventory.ts \
  --url https://mail.example.org --user admin@example.org --out ./migration \
  --add-to-postreeve you@example.org,other@example.org
```

It only reads (`GET /admin/api/v1/domains`, `/boxes`). It writes `migration/inventory.json` and `migration/plan.json` and prints the steps it cannot express (forward-and-keep boxes, disabled boxes, catch-alls with several targets). Compare the field names it expects (`address`, `name`, `redirect_to`, `redirect_only`, `storage_limit`, `disabled`) with your server's API docs at `https://mail.example.org/admin/api/doc`; if `storage_limit` is in bytes, add `--quota-unit bytes`. If the API is unavailable, write `inventory.json` by hand in the same shape and run the script with `--from inventory.json`.

`migration/` holds addresses and later passwords; it is in `.gitignore`. Keep it on the VPS or your own machine only.

## 2. Stage Stalwart beside poste.io

poste.io and Stalwart cannot both bind 25, 465, 587, 993, 4190 (or 80/443) on one host. During staging, Stalwart publishes nothing public. Create `deploy/stalwart/compose.override.yaml`:

```yaml
services:
  stalwart:
    ports: !override
      - "127.0.0.1:8080:8080"   # admin, through tailscale serve
      - "127.0.0.1:1993:993"    # IMAP for imapsync only
```

Start it and complete its first-run setup as in `docs/stalwart.md` (hostname `mail.example.org`, no ACME), connect it in Postreeve, then import the plan as a **proposal**:

```bash
curl -s http://127.0.0.1:3000/api/mail-servers          # note the server id
bun scripts/migration/import-plan.ts --server <id> --plan ./migration/plan.json
```

In Postreeve, **Settings › Mail server › Proposals**: review every operation, enter a new password for each mailbox, approve. Write each new password into `migration/passwords/<address>.new` (`chmod 600`) and the current poste.io password into `<address>.old`; imapsync reads them from there.

Handle the printed manual steps in Stalwart's admin (Sieve redirects for forward-and-keep boxes).

## 3. Publish the new DKIM keys

In Postreeve's DNS checklist for each domain, copy the Stalwart DKIM TXT records (`v1-rsa-…._domainkey`, `v1-ed25519-…._domainkey`) into your DNS hosts (Strato and wherever the other domains live). Leave poste.io's DKIM record in place. Wait until the checklist shows those DKIM rows as OK.

## 4. Bulk copy (poste.io still live)

```bash
bun scripts/migration/imapsync-plan.ts --old mail.example.org --new localhost --new-port 1993 --new-self-signed > migration/sync.sh
sh migration/sync.sh          # dry run: shows folders and counts, copies nothing
bun scripts/migration/imapsync-plan.ts --old mail.example.org --new localhost --new-port 1993 --new-self-signed --live > migration/sync.sh
sh migration/sync.sh          # copies; safe to re-run, it only adds what is missing
```

`--new-self-signed` skips certificate checks for this loopback hop only, because staging Stalwart has no real certificate yet. imapsync never deletes on either side in this configuration. Large mailboxes take hours; this pass runs while poste.io keeps serving mail.

## 5. Cutover (about 15 minutes)

1. Stop poste.io: `docker stop <poste container>`. Inbound mail now waits at the senders.
2. Remove `compose.override.yaml` and start Stalwart with its public ports: `cd deploy/stalwart && docker compose up -d`. Issue the certificate now if you used `--standalone` (port 80 is free) and run the deploy hook.
3. Start poste.io again with **only** its IMAP port on loopback, for the final copy, for example `docker run … -p 127.0.0.1:2993:993 …` with its original volume and no other ports (or `docker compose` with an override that does the same).
4. Final incremental copy: `bun scripts/migration/imapsync-plan.ts --old localhost --old-port 2993 --old-self-signed --new mail.example.org --live > migration/sync.sh`, then run it.
5. Stop the loopback-only poste.io container. Do not delete it or its volume.

## 6. Verify

- Postreeve's DNS checklist: MX, SPF, DKIM and DMARC OK for every domain.
- Send from a Stalwart mailbox to an outside address (Gmail): **Show original** says SPF, DKIM and DMARC pass, and DKIM's `d=` is your domain with a Stalwart selector.
- Send from outside to each domain, including an alias and the catch-all; check it arrives in the right mailbox.
- Compare folder message counts: `imapsync … --justfoldersizes` against both servers, or the counts in Postreeve.
- Postreeve's queue view is empty or only shows expected deferrals.
- Update clients: in Postreeve, use **Add to Postreeve** on each mailbox (it creates an app password), then remove the old poste.io account entries; phones get the new password or an app password from Stalwart's self-service.
- Over the next days, DMARC and TLS reports appear under **Reports**.

## 7. Clean up (a week later)

Remove poste.io's DKIM records, raise TTLs back to normal, then archive and delete the poste.io container and volume once you are sure you will not roll back.

## Rollback

Until step 7 you can go back:

1. `cd deploy/stalwart && docker compose down` (the volume stays).
2. Start poste.io with its original port mappings.
3. Copy any mail Stalwart received since the cutover back with imapsync (Stalwart as `--host1`, poste.io as `--host2`).
4. DNS needs nothing: poste.io's DKIM record is still published and MX/SPF never changed.
