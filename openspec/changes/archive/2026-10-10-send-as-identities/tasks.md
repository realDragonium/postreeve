# Tasks

## 1. Server identities

- [x] 1.1 Add identity contracts (`identitySchema`, `createIdentityInputSchema`) and the `identities` table with store list/add/remove and account-removal cleanup; verify with store tests
- [x] 1.2 Add core service methods and `GET/POST/DELETE /api/accounts/<id>/identities` (201/200 idempotency, primary refused, limit 100); verify with API tests

## 2. Sending from identities

- [x] 2.1 Resolve From in core (primary for direct sends, stored identity for drafts, name fallback) and pass it to senders; verify draft-send tests for alias acceptance and unknown-identity refusal
- [x] 2.2 Use the resolved From in SMTP header and envelope; verify with an SMTP test double
- [x] 2.3 Check Gmail Send-as before alternate-From sends, failing pre-dispatch otherwise; verify with Gmail fetch-double tests

## 3. Web interface

- [x] 3.1 Add API client calls, load identities per account in App, and drive IdentitySheet through the server with error display and Gmail note; verify typecheck and build
- [x] 3.2 Default reply/forward From from the source's delivered-to/To/Cc, exclude own identities from reply recipients, and gate Send on stored identities; verify with unit tests for the pure helpers
- [x] 3.3 Migrate browser-local identities once; verify with unit tests for drop/retry/complete
- [x] 3.4 Update e2e expectations touching identities and FEATURES.md identity rows; verify `bun run test:e2e` if a browser is available

## 4. Integration

- [x] 4.1 Run `bun run typecheck`, `bun run test`, `bun run build` and `bunx openspec validate --specs --strict`

## Workflow follow-up

- Archive the change in the same branch, rebase on origin/main, open the PR.
