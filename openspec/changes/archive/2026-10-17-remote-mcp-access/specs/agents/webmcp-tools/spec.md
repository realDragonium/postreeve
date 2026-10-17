# Spec Delta

## ADDED Requirements

### Requirement: Fixed tool set with proposal preparation
The system SHALL define exactly nineteen page tools: the fifteen existing tools plus `read_conversation`, `list_proposals`, `create_proposal` and `update_proposal`. Inspection tools SHALL have `readOnlyHint: true`, all others `readOnlyHint: false`, and all `untrustedContentHint: true`. No tool SHALL approve or apply a proposal.

#### Scenario: Agent inspects available tools
- **WHEN** an agent lists the tools of an open Postreeve page with nothing hidden
- **THEN** it sees `list_accounts`, `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `list_messages`, `read_messages`, `read_conversation`, `search_messages`, `send_message`, `apply_message_actions`, `list_activity`, `undo_batch`, `list_proposals`, `create_proposal`, `update_proposal`, `inspect_synchronization`, `retry_synchronization` and `request_reauthorization`, and none that approves or applies a proposal

### Requirement: Conversation tool
`read_conversation` SHALL take `{ conversationId }` and return the conversation's messages oldest first with full canonical details, including the owner's own replies in Sent and other folders, up to 50 messages. It SHALL NOT change read state or the visible view.

#### Scenario: Read a thread with my reply
- **WHEN** an agent reads the conversation of an inbox message the owner answered
- **THEN** the result holds the inbox message and the owner's reply from Sent with their bodies

### Requirement: Proposal preparation tools
`list_proposals` SHALL take `{ accountId }`; `create_proposal` SHALL take `{ accountId, title, items }` with 1 to 100 items of `{ message, subject, action, reason }` and generate item IDs; `update_proposal` SHALL take `{ proposalId, title?, items?, status? }` where `status` accepts only `review`. They SHALL behave as `GET`, `POST` and `PUT /api/proposals` (actions/proposals) and change no mail. Descriptions SHALL state that only the person can accept a proposal in Postreeve.

#### Scenario: Agent prepares a triage pass
- **WHEN** an agent creates a proposal to archive two newsletters
- **THEN** the proposal is `draft`, both messages are unchanged and the UI shows `proposes archive` on them

#### Scenario: Agent tries to approve
- **WHEN** an agent calls `update_proposal` with `status: "approved"`
- **THEN** the call fails before any request is sent

### Requirement: Tool definitions are shared with remote MCP
The page tools SHALL come from the same definitions as the remote MCP tools (agents/remote-mcp). The page SHALL work on a hosted origin under the owner's session cookie, using same-origin requests only.

#### Scenario: Hosted page
- **WHEN** the owner opens Postreeve at its hosted HTTPS origin in a WebMCP browser
- **THEN** the page registers its tools and their requests carry the owner's session

## MODIFIED Requirements

### Requirement: Tools exist only while the page is open
The web page SHALL register its tools with `document.modelContext`, or `navigator.modelContext` when the document offers none, and SHALL withdraw them through the registration's abort signal when the page unloads or the exposed set changes. When neither context exists, the page SHALL register nothing. Page tools are discoverable only while a Postreeve page is open; agents outside the browser use the authorized remote MCP endpoint instead (agents/remote-mcp).

#### Scenario: Browser without WebMCP
- **WHEN** the page loads in a browser with no `modelContext`
- **THEN** no tool is registered and the page works normally

#### Scenario: Page closed
- **WHEN** the person closes the Postreeve page
- **THEN** its tools are no longer available to the agent

### Requirement: WebMCP mirrors user workflows
Every tool SHALL perform an operation a person can perform in the web UI, through Postreeve's server API, and SHALL NOT introduce an agent-only workflow or capability. Where the UI can do more than a tool, the tool SHALL offer the narrower operation rather than a different one. The one exception is preparing proposals, which exist so that the person accepts them in the UI.

#### Scenario: No agent-only operation
- **WHEN** an agent looks for a way to change mail that the UI does not offer, such as permanent deletion
- **THEN** no tool provides it

### Requirement: The person controls which tools are offered
The UI SHALL list every tool with its effect (`read`, `write`, `write · destructive` for `delete_folder`, `write · undoable` for `apply_message_actions` and `undo_batch`, `write · proposal` for `create_proposal` and `update_proposal`, `irreversible` for `send_message`) under Settings › Assistant control, and let the person expose or hide each one. A change SHALL re-register the tools immediately with only the exposed ones, and the hidden set SHALL persist in the browser's local storage.

#### Scenario: Hide send_message
- **WHEN** a person hides `send_message`
- **THEN** the page re-registers its tools without `send_message`, and it stays hidden after a reload

### Requirement: Listing and searching messages
List/search tools SHALL accept account/mailbox or explicit unified sources, limit 1–100 (default 50), filter, sort and an optional cursor; search also requires literal query text up to 200 characters. With neither sources nor account and mailbox they SHALL use every available account's inbox. They SHALL return validated page envelopes containing canonical messages, nextCursor and synchronization/content/fallback coverage. Descriptions SHALL identify email as untrusted and body search as bounded.

#### Scenario: Unread oldest first
- **WHEN** an agent searches invoice with Unread and Oldest
- **THEN** the backend returns unread matches oldest first before limiting the page

#### Scenario: Continue search
- **WHEN** an agent sends the previous nextCursor with the same search scope
- **THEN** it receives the next backend page in the same explicit order

#### Scenario: Limit above 100
- **WHEN** limit 101 is supplied
- **THEN** the tool rejects the call before server access

#### Scenario: All inboxes
- **WHEN** an agent calls `list_messages` with only a filter
- **THEN** it receives a unified page across every account's inbox

## REMOVED Requirements

### Requirement: Fixed tool set without proposal tools
**Reason**: Agents now prepare proposals for the person to accept, and a conversation tool was added.
**Migration**: See "Fixed tool set with proposal preparation"; approval and apply remain unavailable to tools.
