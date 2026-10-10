# Tasks

## 1. Server

- [x] 1.1 Add the `correspondents` table, triggers on `indexed_messages` and one-time backfill in a new `src/server/contacts` module created by the store; verify with store tests for sent/received counting, name recency, dedupe across accounts, removal of indexed messages, retention updates and account removal
- [x] 1.2 Add the suggestion query with own-address exclusion and ranking, the shared `recipientSuggestionSchema`/query schema, the core service method and `GET /api/recipient-suggestions`; verify with API tests for matching, ranking, exclusion, limits and 400s

## 2. Web interface

- [x] 2.1 Add the API client call and a `RecipientInput` combobox for To/Cc/Bcc with debounced lookup and keyboard handling, keeping text values and validation; verify pure token helpers with unit tests and with typecheck/build
- [x] 2.2 Update FEATURES.md compose rows; verify e2e with the indexed-search test double if a browser is available

## 3. Integration

- [x] 3.1 Run `bun run typecheck`, `bun run test`, `bun run build` and `bunx openspec validate --specs --strict`

## Workflow follow-up

- Archive the change in the same branch, rebase on origin/main, open the PR against main.
