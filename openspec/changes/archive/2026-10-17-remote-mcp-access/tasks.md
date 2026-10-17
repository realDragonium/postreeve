# Tasks

## 1. Shared tool layer

- [x] 1.1 Add `scope`, `surfaces` and `destructive` to the tool definitions, keep `createPostreeveWebMcpTools` stripping them, and verify `tests/webmcp.test.ts` passes with nineteen page tools
- [x] 1.2 Add `read_conversation`, `list_proposals`, `create_proposal`, `update_proposal` and default inbox sources to the shared layer and the browser services, and verify with webmcp tests
- [x] 1.3 Add the new tools' effects to Settings › Assistant control and verify typecheck

## 2. Storage and owner-auth contract

- [x] 2.1 Add Drizzle tables and migration 900001 for agent clients, grants, codes, tokens and events, and verify a store migration test sees the tables
- [x] 2.2 Add `AgentAccessStore` with hashed secrets, grant lifecycle, token rotation and event pruning, and verify unit tests
- [x] 2.3 Add the owner-auth placeholder and re-export, and verify loopback sessions only

## 3. OAuth authorization server

- [x] 3.1 Serve protected resource and authorization server metadata with the public origin, and verify contract tests
- [x] 3.2 Implement dynamic client registration with redirect validation and pruning, and verify contract tests
- [x] 3.3 Implement authorize validation, consent page and decision, and verify contract tests for no session, deny and allow
- [x] 3.4 Implement the token endpoint (PKCE code exchange, refresh rotation, reuse detection) and revocation, and verify contract tests

## 4. Remote MCP endpoint

- [x] 4.1 Implement server-side services with account restriction and the `/mcp` handler with scope filtering and auditing, and verify a tool call round-trip against the test doubles
- [x] 4.2 Verify scope enforcement, revoked token 401, no send/approve tools and approve-through-update refusal in contract tests
- [x] 4.3 Mount the router in `src/server/index.ts` and verify `bun run typecheck`

## 5. Settings and Activity

- [x] 5.1 Add `/api/agent-access` grants, token creation, revoke and events routes, and verify contract tests
- [x] 5.2 Add Settings › Connected agents (list, revoke, PAT creation, connection URL) and verify `bun run build`
- [x] 5.3 Show remote agent rows and batch attribution in Activity, and verify provenance tests

## 6. Docs and integration

- [x] 6.1 Update FEATURES.md and README.md with remote MCP, scopes and how to connect Claude and ChatGPT
- [x] 6.2 Run `bun run verify` and `bunx openspec validate --specs --strict`

## Workflow follow-up

- Archive the change in this branch so the main specs merge with the code.
