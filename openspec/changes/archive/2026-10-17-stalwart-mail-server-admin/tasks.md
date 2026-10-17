# Tasks

## 1. Vault and storage

- [x] 1.1 Add `encryptSecret`/`decryptSecret` to `CredentialVault` and verify with a round-trip and wrong-key test in `tests/credentials.test.ts`
- [x] 1.2 Add migration `910001` and `MailServerStore` (servers, proposals) in `src/server/stalwart/store.ts`; verify a fresh and a re-opened database in `tests/stalwart-admin.test.ts`

## 2. Stalwart client and fake

- [x] 2.1 Build the JMAP client (`src/server/stalwart/client.ts`): session check, Basic/Bearer auth, 15 s timeout, method and set error mapping; verify against the fake with wrong-key, non-Stalwart and unreachable cases
- [x] 2.2 Build `tests/support/fake-stalwart.ts` with the v0.16.26 wire encoding for domains, accounts, app passwords, lists, DKIM, queue, reports, spam settings and lookup keys

## 3. Admin service and routes

- [x] 3.1 Connect, list, update and disconnect servers with the admin URL policy; verify no secret appears in any response
- [x] 3.2 Domains, typed-confirmation delete with DKIM cleanup, catch-all validation; verify the spec scenarios
- [x] 3.3 Mailboxes (create, rename, quota, password reset, aliases, typed-confirmation delete) and mailing lists; verify the spec scenarios
- [x] 3.4 One-step Postreeve account via app password with revoke on failure, and alias/catch-all identity registration; verify both success and partial-failure paths
- [x] 3.5 DKIM list, generate (RSA-2048, Ed25519) and delete; verify the private key is not stored or returned
- [x] 3.6 Queue list, retry, cancel; DMARC and TLS report summaries; spam settings and trusted/blocked domains; verify each against the fake
- [x] 3.7 Mount routes under `/api/mail-servers` and verify through `app.request` in tests

## 4. DNS checklist

- [x] 4.1 Parse Stalwart's zone file into categorized records; verify with the real v0.16.26 zone output
- [x] 4.2 DNS-over-HTTPS and system lookups behind one interface with per-record status (`ok`, `missing`, `different`, `error`); verify with a fake lookup

## 5. Agent tools and proposals

- [x] 5.1 `mailServerTools` with the four read-only tools and `propose_mail_server_change`; verify strict schemas, no secrets, and no approve/apply tool
- [x] 5.2 Proposal approve (with owner-entered passwords and typed confirmations), reject and apply-in-order; verify stop-on-failure and that approval is only an HTTP route

## 6. Web UI

- [x] 6.1 `src/web/admin/` API client and Mail server view (servers, domains, mailboxes, lists, DKIM, DNS checklist with copy buttons, queue, reports, spam, proposals) wired as a Settings section; verify `bun run build` and the pure helpers' tests
- [x] 6.2 Typed-confirmation dialogs for domain and mailbox deletion and for destructive proposals

## 7. Deployment and migration docs

- [x] 7.1 `docs/stalwart.md` and `deploy/stalwart/compose.yaml` (own network and volume, mail ports public, admin on the tailnet, port coexistence with poste.io); verify `docker compose config` parses the file when Docker is available
- [x] 7.2 `docs/migrate-poste-io.md` and read-only helpers in `scripts/migration/` (inventory from poste.io, plan file for Postreeve, imapsync command generator); verify the helpers' dry-run tests
- [x] 7.3 Update README.md and FEATURES.md with the Mail server area

## 8. Integration

- [x] 8.1 `scripts/stalwart-test-instance.ts` and opt-in `tests/stalwart-live.test.ts`; run it against a throwaway v0.16.26 instance
- [x] 8.2 `bun run verify` and `bunx openspec validate --specs --strict` pass

## Workflow follow-up

- Archive the change in the same branch once implemented and verified.
- At merge with feat/remote-mcp, register `mailServerTools` in the shared tool layer (read-only under `mail:read`, propose under `mail:propose`).
