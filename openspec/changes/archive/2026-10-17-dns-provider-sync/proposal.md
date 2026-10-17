# Proposal

## Why

The owner's domains sit on Cloudflare (most) and GoDaddy (some). The Stalwart DNS checklist tells them which records to publish, but copying a dozen values per domain by hand is slow and error-prone, and the move from poste.io needs the new DKIM records in place before a short cutover window. The owner also settled the host layout: Caddy fronts ports 80/443 and Stalwart's admin stays tailnet-only, which changes how Stalwart gets its certificate and which HTTP paths are public.

## What Changes

- Connect DNS providers in the Mail server area: Cloudflare with a scoped API token (Zone:DNS:Edit on chosen zones) and GoDaddy with an API key and secret. Credentials go in the encrypted vault.
- For each mail server domain, Postreeve finds the provider zone that holds it and shows a diff of create, update and delete changes needed to match the DNS checklist. Nothing is written until the owner selects changes and confirms in the UI.
- Postreeve remembers the records it created. It never deletes or changes a record it did not create unless the owner ticks that record individually.
- GoDaddy restricts its production DNS API to some accounts; when GoDaddy answers 403, the domain falls back to the copyable checklist with the reason.
- Agents can propose applying a domain's DNS changes; approval applies only the default selection (creates, and changes to records Postreeve created).
- Docs: Stalwart's HTTP listener behind Caddy for autoconfig, autodiscover and MTA-STS only; admin and management API reachable only over the tailnet and a private Docker network from Postreeve; Stalwart's certificate via its own ACME client with Cloudflare DNS-01; the poste.io cutover as one maintenance window on the same host.
- Out of scope: the Strato domain stays an ordinary IMAP account.

## Capabilities

### New Capabilities
- `server/dns-providers`: connecting Cloudflare and GoDaddy, planning DNS changes per domain against the checklist, record ownership, and applying selected changes after confirmation.

### Modified Capabilities
- `agents/mail-server-tools`: the proposal tool gains an operation that applies a domain's default DNS changes on approval.
- `accounts/credential-vault`: the vault also protects DNS provider credentials.

## Impact

- New `src/server/dns-providers/*` (Cloudflare and GoDaddy clients, planner, store, service), routes under `/api/dns-providers` and `/api/mail-servers/:id/domains/:id/dns/plan|apply`, migration `910002`.
- Mail server UI: a DNS providers tab and a diff-and-apply panel in the DNS tab.
- Outbound HTTPS to `api.cloudflare.com` and `api.godaddy.com`, only when a provider is connected.
- Docs: `docs/self-host.md` (Stalwart Caddy routes, replacing placeholders), `docs/stalwart.md`, `deploy/stalwart/compose.yaml`, `docs/migrate-poste-io.md`.
