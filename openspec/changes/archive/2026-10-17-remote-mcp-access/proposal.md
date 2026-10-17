# Proposal

## Why

Postreeve is moving from a loopback-only app to a hosted web app the owner uses daily. Today an agent can only reach mail through page-scoped WebMCP tools while a Postreeve tab is open. Claude (claude.ai, Claude Code) and ChatGPT connect to remote MCP servers with OAuth, so the owner's agents cannot reach their mail from anywhere else.

## What Changes

- A remote MCP endpoint at `/mcp` (Streamable HTTP, stateless JSON responses) offers the same mailbox tools as WebMCP, from one shared tool definition layer. It never offers `send_message` and has no tool that approves or applies a proposal.
- The shared tool layer gains `read_conversation` (all messages of a conversation with bodies, across the agent's accounts), `list_proposals`, `create_proposal` and `update_proposal`. `list_messages` and `search_messages` default to every account's inbox when no source is given. WebMCP offers the new tools too.
- `/mcp` is protected by the MCP authorization spec: OAuth 2.1 authorization code with PKCE (S256), protected resource metadata, authorization server metadata, dynamic client registration, refresh token rotation and token revocation.
- The authorize step shows a consent page that requires a signed-in owner session. The owner picks a tier (read only; read and propose; read, propose and act) and which accounts the agent can reach.
- Clients, codes and tokens are stored hashed in SQLite (new migration). The owner can create personal access tokens for CLI agents.
- Settings gets a **Connected agents** section listing every grant with its scopes, accounts and last use, a revoke button, PAT creation and connection instructions.
- The server records every remote agent tool call with the agent's name. Activity shows those calls and attributes batches an agent applied to that agent by name.
- **BREAKING (spec)**: the webmcp-tools rule "the server offers no MCP endpoint" and "no tool creates or updates a proposal" are replaced; approval and apply stay human-only.

## Capabilities

### New Capabilities

- `agents/remote-mcp`: The `/mcp` endpoint, its tool set per scope, account restriction, tool call auditing and the human approval boundary for remote agents.
- `agents/agent-authorization`: OAuth 2.1 authorization server for agents (metadata, registration, consent, codes, tokens, refresh, revocation), personal access tokens and the Connected agents settings.

### Modified Capabilities

- `agents/webmcp-tools`: Tool definitions are shared with remote MCP; adds `read_conversation` and the proposal preparation tools; default sources for listing; no longer forbids a server MCP endpoint.
- `actions/proposals`: Agents may create and update proposals through tools; approval stays with the human UI.
- `actions/activity-undo`: The server records remote agent provenance and Activity shows it.

## Impact

- New dependency `@modelcontextprotocol/sdk`.
- New server modules under `src/server/agent-access/` and `src/server/mcp/`; one router mounted in `src/server/index.ts`.
- Database: new tables `agent_clients`, `agent_grants`, `agent_codes`, `agent_tokens`, `agent_events` (migration 900001). No existing table changes.
- `src/server/webmcp/tools.ts` and `types.ts` become the shared tool layer; `src/web/webmcp.ts` implements the new services.
- Web: Settings › Connected agents, Activity agent rows and attribution.
- Depends on the owner-auth workstream's `requireOwner` and `getOwnerSession`; a placeholder ships until it merges.
- FEATURES.md and README.md.
