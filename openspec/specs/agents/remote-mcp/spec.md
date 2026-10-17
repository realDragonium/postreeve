# agents/remote-mcp Specification

## Purpose
Covers the remote MCP endpoint through which an authorized agent outside the browser (Claude, ChatGPT, a CLI agent) works with the owner's mail: transport, tool set per scope, account restriction, auditing and the human approval boundary.

## Requirements

### Requirement: Streamable HTTP endpoint at /mcp
The server SHALL serve MCP over the Streamable HTTP transport at `/mcp` without sessions: each `POST` carries one JSON-RPC message or batch and is answered with a JSON response. `GET` and `DELETE` SHALL be answered with 405. Responses SHALL allow cross-origin callers, because authorization uses a bearer token and never a cookie.

#### Scenario: Initialize
- **WHEN** an authorized client posts an `initialize` request to `/mcp`
- **THEN** the response is 200 JSON naming the server `postreeve` with the `tools` capability and no `Mcp-Session-Id`

#### Scenario: Stream request
- **WHEN** a client sends `GET /mcp`
- **THEN** the response is 405

### Requirement: Bearer token required
Every `/mcp` request SHALL carry `Authorization: Bearer <token>` naming an unexpired, unrevoked access token or personal access token whose grant is active (agents/agent-authorization). Otherwise the server SHALL answer 401 with `WWW-Authenticate: Bearer` carrying `resource_metadata` with the protected resource metadata URL, and `error="invalid_token"` when a token was presented.

#### Scenario: No token
- **WHEN** a client posts to `/mcp` without `Authorization`
- **THEN** the response is 401 and `WWW-Authenticate` names `resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`

#### Scenario: Revoked token
- **WHEN** the owner revokes an agent and the agent calls `/mcp` with its old access token
- **THEN** the response is 401 with `error="invalid_token"`

### Requirement: Shared tool definitions
Remote MCP tools SHALL use the same names, descriptions, JSON input schemas, validation and result contracts as the WebMCP tools (agents/webmcp-tools), from one shared definition. Each tool SHALL publish MCP annotations `readOnlyHint`, `destructiveHint` (true only for `delete_folder`) and `openWorldHint: false`. Results SHALL be returned as JSON text content; a failure SHALL be a tool result with `isError: true` and the error message.

#### Scenario: Same schema on both surfaces
- **WHEN** an agent lists `list_folders` over remote MCP
- **THEN** its input schema equals the WebMCP `list_folders` input schema

#### Scenario: Invalid input
- **WHEN** an agent calls `list_folders` with an unknown property
- **THEN** the result has `isError: true` and no mailbox is read

### Requirement: Tools offered per scope
The server SHALL list and accept only the tools the grant's scopes allow. `mail:read` allows every tool with `readOnlyHint: true` and `request_reauthorization`. `mail:propose` adds `create_proposal` and `update_proposal`; `mail:draft` adds `create_draft` and `update_draft`. `mail:act` adds `create_folder`, `rename_folder`, `delete_folder`, `apply_message_actions`, `undo_batch` and `retry_synchronization`.

#### Scenario: Read-only agent
- **WHEN** an agent with only `mail:read` lists tools
- **THEN** no proposal, draft, folder change, action, undo or retry tool is listed

#### Scenario: Read-only agent tries to act
- **WHEN** an agent with only `mail:read` calls `apply_message_actions`
- **THEN** the call fails with an error and no mail changes

#### Scenario: Read-only agent tries to draft
- **WHEN** an agent with only `mail:read` calls `create_draft`
- **THEN** the call fails and no draft is stored

### Requirement: Remote agents never send or approve
Remote MCP SHALL NOT offer `send_message`, unsubscribe, any tool that sends a draft, or any tool that approves, applies or declines a proposal, under any scope. `update_proposal` SHALL accept only `draft` or `review` status changes, as `PUT /api/proposals/<id>` does.

#### Scenario: Full-scope tool list
- **WHEN** an agent with every scope lists tools
- **THEN** `send_message` is absent and no tool name contains `approve`, `decline`, `apply_proposal` or `send`

#### Scenario: Approve through update
- **WHEN** an agent calls `update_proposal` with `status: "approved"`
- **THEN** the call fails and the proposal keeps its status and a null `approvedAt`

### Requirement: Account restriction
A grant restricted to accounts SHALL see only those accounts. `list_accounts` and `inspect_synchronization` SHALL omit other accounts; any tool input that names another account through `accountId`, a source, a message reference, a batch or a proposal SHALL fail with `Account not available to this agent` before reaching the mail provider. `read_conversation` SHALL return only messages in allowed accounts.

#### Scenario: Other account
- **WHEN** an agent restricted to account A calls `list_folders` for account B
- **THEN** the call fails with `Account not available to this agent`

#### Scenario: Default inboxes
- **WHEN** an agent restricted to account A calls `list_messages` with no source
- **THEN** only account A's inbox is listed

### Requirement: Every remote tool call is audited
The server SHALL record each remote tool call with time, grant, agent name, tool name, the account it named, outcome (`ok` or `error`), a short summary without message content, and the batch or proposal it produced. It SHALL keep the newest 5,000 records and update the grant's last use.

#### Scenario: Agent archives mail
- **WHEN** an agent named `Claude` applies an archive through `apply_message_actions`
- **THEN** an audit record names `Claude`, `apply_message_actions`, outcome `ok` and the returned batch ID

#### Scenario: Agent reads
- **WHEN** an agent reads three messages
- **THEN** an audit record names `read_messages` with summary `3 messages` and no message text

### Requirement: Public agent endpoints are rate limited
The server SHALL count requests per client address and answer 429 `{ error: "rate_limited" }` with `Retry-After` once a limit is exceeded: `/oauth/register` 10 per hour, `/oauth/token` and `/oauth/revoke` 60 per minute, unauthenticated `/mcp` requests 30 per minute. The address SHALL be the last `X-Forwarded-For` entry when the TCP peer is loopback, and the peer's address otherwise. Authenticated `/mcp` requests SHALL be limited to 120 per minute per token.

#### Scenario: Registration flood
- **WHEN** one address sends an eleventh registration within an hour
- **THEN** the response is 429 with `Retry-After` and no client is stored

#### Scenario: Busy agent
- **WHEN** one token sends a 121st `/mcp` request within a minute
- **THEN** the response is 429 and no tool runs

#### Scenario: Forged header from a direct caller
- **WHEN** a non-loopback peer sends `X-Forwarded-For: 10.0.0.1`
- **THEN** it is counted under its own address

### Requirement: Public agent endpoints bound request bodies
The server SHALL refuse with 413 `{ error: "payload_too_large" }` a request body over 1 MiB on `/mcp` and over 16 KiB on `/oauth/register`, `/oauth/token` and `/oauth/revoke`, before parsing it.

#### Scenario: Oversized MCP request
- **WHEN** a client posts a 2 MiB body to `/mcp`
- **THEN** the response is 413 and no tool runs

### Requirement: Public agent endpoints hide internal failures
An unexpected failure while handling `/mcp`, the OAuth endpoints or the metadata endpoints SHALL be answered with 500 `{ error: "server_error" }` and no stack trace or internal message; the server SHALL log the failure.

#### Scenario: Internal error
- **WHEN** the database fails while a token is checked
- **THEN** the client receives 500 `server_error` without the database message

### Requirement: Public listener serves only agent endpoints
The router for the public listener SHALL serve only `/mcp`, `/.well-known/oauth-protected-resource` (and `/mcp` beneath it), `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`, and SHALL answer 404 for `/oauth/authorize`, `/api/*` and every other path. Rate-limit counters SHALL be shared with the private listener of the same server.

#### Scenario: Consent page on the public listener
- **WHEN** a client requests `/oauth/authorize` on the public listener
- **THEN** the response is 404

#### Scenario: Limits span listeners
- **WHEN** one address registers five clients on each listener within an hour and then once more
- **THEN** the last registration is answered with 429
