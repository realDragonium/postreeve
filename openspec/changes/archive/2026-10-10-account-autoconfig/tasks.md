# Tasks

## 1. Discovery on the server

- [x] 1.1 Add discovery request/response schemas to `src/shared/contracts.ts` and verify with `bun run typecheck`
- [x] 1.2 Add the provider table (`src/server/accounts/providers.ts`) and discovery module (`src/server/accounts/discovery.ts`) with domain validation, limited fetch, autoconfig parsing and MX matching; verify with unit tests in `tests/account-discovery.test.ts` covering preset (no fetch), autoconfig precedence, ISPDB fallback, MX match, plain-only rejection, redirect/oversize/timeout as no answer, IP-literal and single-label domains, placeholder expansion and unsupported providers
- [x] 1.3 Add `POST /api/accounts/discover` with injected discovery and default it to real `fetch`/`resolveMx` in `createApi`; verify with an API test for 200 and 400 responses

## 2. Account sheet

- [x] 2.1 Add `api.discoverAccount` in `src/web/api.ts` with response validation and verify with a web API test
- [x] 2.2 Reorder the new-account sheet, add **Find settings**, source status, fixed provider guidance and Gmail steering in `src/web/panels.tsx`; verify with `bun run typecheck`, `bun run build` and the running app against a stubbed discovery result (Playwright test in `tests/e2e/main-workflow.spec.ts`)

## 3. Documentation and integration

- [x] 3.1 Update README.md and FEATURES.md for settings discovery and verify the text matches the spec
- [x] 3.2 Run `bun run typecheck`, `bun run test`, `bun run build` and `bunx openspec validate --specs --strict` (plus `bun run test:e2e` if a browser is available) and record results

## Workflow follow-up

- Archive the change in the same branch after verification, then rebase on origin/main and open the PR.
