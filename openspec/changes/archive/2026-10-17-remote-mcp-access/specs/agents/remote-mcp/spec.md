# Spec Delta

## Purpose

Covers the remote MCP endpoint through which an authorized agent outside the browser (Claude, ChatGPT, a CLI agent) works with the owner's mail: transport, tool set per scope, account restriction, auditing and the human approval boundary.

## ADDED Requirements

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
The server SHALL list and accept only the tools the grant's scopes allow. `mail:read` allows `list_accounts`, `list_folders`, `list_messages`, `search_messages`, `read_messages`, `read_conversation`, `list_activity`, `list_proposals`, `inspect_synchronization` and `request_reauthorization`. `mail:propose` adds `create_proposal` and `update_proposal`. `mail:act` adds `create_folder`, `rename_folder`, `delete_folder`, `apply_message_actions`, `undo_batch` and `retry_synchronization`.

#### Scenario: Read-only agent
- **WHEN** an agent with only `mail:read` lists tools
- **THEN** no proposal, folder change, action, undo or retry tool is listed

#### Scenario: Read-only agent tries to act
- **WHEN** an agent with only `mail:read` calls `apply_message_actions`
- **THEN** the call fails with an error and no mail changes

### Requirement: Remote agents never send or approve
Remote MCP SHALL NOT offer `send_message`, unsubscribe, or any tool that approves or applies a proposal, under any scope. `update_proposal` SHALL accept only `draft` or `review` status changes, as `PUT /api/proposals/<id>` does.

#### Scenario: Full-scope tool list
- **WHEN** an agent with every scope lists tools
- **THEN** `send_message` is absent and no tool name contains `approve` or `apply_proposal`

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
