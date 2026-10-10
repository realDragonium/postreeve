# Tasks

## 1. Host and Origin guards

- [x] 1.1 Add `src/server/security/request-origin.ts` with `allowedHostGuard` and `sameOriginGuard`; verify with focused unit tests in `tests/request-origin.test.ts` (loopback names, any port, IPv6, configured host, wildcard bind, rebound host, missing Host, same-origin POST, cross-site POST, missing Origin, GET exemption)
- [x] 1.2 Install the guards in `src/server/index.ts` before desktop authentication, skipping the Origin guard when a desktop token is configured; verify `bun run typecheck`
- [x] 1.3 Document the Host/Origin behavior and the non-loopback `POSTREEVE_HOST` rule in README.md; verify the text matches the spec

## 2. Sent copy after settlement

- [x] 2.1 Split Sent copy saving out of `#dispatchMessageSend`; `sendMessage` saves it after dispatch and `sendDraft` saves it after `settleDraftSend` (and in the settlement-failure path); verify existing `tests/sent-copies.test.ts` passes
- [x] 2.2 Add `Store.updateSentDraftReceipt` and store the Sent-copy warning on the sent draft; add a test that the draft is already `sent` while the copy is appended, and keep the warning test passing
- [x] 2.3 Pass bounded timeouts (30 s connection, 16 s greeting, 60 s socket) to the IMAP client used by `appendSentMessage`; verify in `tests/imap-compatibility.test.ts` that the append client receives them

## 3. Integration

- [x] 3.1 Run `bun run typecheck`, `bun run test`, `bun run build`, `bunx openspec validate --specs --strict`, and `bun run test:e2e` when a browser is available
- [x] 3.2 Start the server locally against an empty temporary database and check with curl that a loopback Host is accepted, a foreign Host and a cross-site POST are rejected

## Workflow follow-up

- Archive the change in the same pull request after verification.
