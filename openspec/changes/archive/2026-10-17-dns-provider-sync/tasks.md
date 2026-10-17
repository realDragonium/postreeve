# Tasks

## 1. Provider clients and fakes

- [x] 1.1 Cloudflare client (zones, records, create/update/delete, comment marker, error mapping) and a deterministic fake; verify list/create/update/delete and an invalid token in `tests/dns-providers.test.ts`
- [x] 1.2 GoDaddy client (sso-key auth, type+name record sets, 403 detection) and fake; verify set edits and the 403 fallback

## 2. Planner, ledger and service

- [x] 2.1 Pure planner with the ownership and default-selection rules and a fingerprint; verify each rule in design decision 3 with unit tests
- [x] 2.2 Migration `910002`, provider store and owned-record ledger; DnsProviders service (connect, list, disconnect, plan, apply with fingerprint check); verify secrets never appear in responses
- [x] 2.3 Routes under `/api/dns-providers` and the plan/apply routes per domain; verify through the routes; the owner guard comes from `createServerApp`

## 3. Agents and UI

- [x] 3.1 `applyDnsChanges` proposal operation applying only the default selection; verify foreign changes stay untouched on approval
- [x] 3.2 DNS providers tab and the diff-and-apply panel with per-change checkboxes and a confirmation sheet; verify `bun run build` and a screenshot against fakes

## 4. Host layout docs

- [x] 4.1 Stalwart routes in `docs/self-host.md` replacing its placeholders; `deploy/stalwart/compose.yaml` with the `mail-admin` internal network; `docs/stalwart.md` with Cloudflare DNS-01 and the private admin path; verify `docker compose config`
- [x] 4.2 `docs/migrate-poste-io.md` as one maintenance window with DNS applied through Postreeve; README and FEATURES

## 5. Integration

- [x] 5.1 `bun run verify`, the e2e suite, and `bunx openspec validate --specs --strict` pass

## Workflow follow-up

- Archive the change in the same branch once verified.
