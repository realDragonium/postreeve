# Tasks

## 1. Conversation summaries endpoint
- [x] 1.1 Add the synchronization-store lookup, service method, API route and web client for `GET /api/conversations/:id/messages`; verify with an API test covering a reply in Sent, a member without a location and an unknown ID.

## 2. Conversation reader
- [x] 2.1 Add a pure thread/expansion helper and verify unit tests for substitution of the opened row, missing opened row and initial expansion.
- [x] 2.2 Split the reader into a conversation view with per-message headers, attachments, bodies and reply buttons loaded on demand; verify `bun run typecheck` and `bun run build`.
- [x] 2.3 Add a browser test that opens a message, sees a collapsed earlier message and a Sent reply, expands it, and replies to it; verify the existing e2e suite still passes.
- [x] 2.4 Update FEATURES.md for conversation reading and verify it matches the delivered behavior.

## 3. Integration
- [x] 3.1 Run `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:e2e` and `bunx openspec validate --specs --strict`; resolve failures.

## Workflow follow-up
- Archive the change in the same branch, then rebase on origin/main and open the PR.
