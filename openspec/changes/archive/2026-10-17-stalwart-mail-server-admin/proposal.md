# Proposal

## Why

The owner is replacing a self-hosted poste.io with Stalwart Mail Server and wants Postreeve to be the one place to run their mail: the server's domains, mailboxes and DNS as well as the inbox. Today every server change means leaving Postreeve for Stalwart's own web admin, then adding each new mailbox to Postreeve by hand with its password.

## What Changes

- A **Mail server** area in Settings connects one or more Stalwart v0.16 instances by URL plus an admin API key (or admin username and password). Postreeve stores that credential in the encrypted vault and talks to Stalwart's JMAP management API (`urn:stalwart:jmap`).
- Manage domains (add, remove), mailboxes (create, display name, quota, reset password, aliases, delete), catch-all addresses, mailing lists and DKIM keys (list, generate, remove).
- A per-domain DNS checklist built from the zone Stalwart generates (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, autoconfig, autodiscover, SRV), each record checked live over DNS-over-HTTPS or the system resolver and shown with a copy button.
- Queue view (deferred and stuck messages, retry now, cancel), received DMARC and TLS reports, and the spam settings that matter: the spam, reject and discard score thresholds, trusted and blocked sender domains.
- Creating a mailbox can also add it to Postreeve as an IMAP/SMTP account in one step. Postreeve asks Stalwart for a per-mailbox app password and stores only that, never the mailbox password.
- Adding an alias or catch-all to a mailbox that is also a Postreeve account registers the matching send-as identity.
- Agents get read-only tools (domains, DNS health, queue status) and can prepare a mail-server change proposal. Only the human UI approves and applies it. Deleting a domain or mailbox always needs the name typed again in the UI.
- Docs: Stalwart deployment next to Postreeve (own compose file, network and volume; mail ports public, admin tailnet-only), poste.io to Stalwart migration runbook with read-only helper scripts, DNS cutover and rollback.

## Capabilities

### New Capabilities
- `server/mail-server-admin`: connecting a Stalwart server and managing its domains, mailboxes, aliases, catch-all, mailing lists, DKIM keys, queue, reports and spam settings from Postreeve, including the one-step mailbox account and identity registration.
- `server/dns-checklist`: the per-domain list of required DNS records with live verification and copyable values.
- `agents/mail-server-tools`: what agents may read about a mail server and how they propose changes under the human approval boundary.

### Modified Capabilities
- `accounts/credential-vault`: the vault also protects mail-server admin credentials.

## Impact

- New server module `src/server/stalwart/*`, routes under `/api/mail-servers`, own SQLite migration (mail servers and server change proposals).
- New web module `src/web/admin/*`, one new Settings section.
- `src/server/security/credentials.ts` gains generic encrypt/decrypt for non-account secrets.
- Outbound HTTPS from the Postreeve server to the Stalwart admin URL and to the DNS-over-HTTPS resolver.
- Docs `docs/stalwart.md`, `docs/migrate-poste-io.md`, `deploy/stalwart/compose.yaml`, read-only helper scripts under `scripts/migration/`.
- No new npm dependencies.
