# Spec Delta

## MODIFIED Requirements

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
