## MODIFIED Requirements

### Requirement: WebMCP mirrors user workflows
Every tool SHALL perform an operation a person can perform in the web UI, through Postreeve's server API, and SHALL NOT introduce an agent-only workflow or capability. Where the UI can do more than a tool, the tool SHALL offer the narrower operation rather than a different one.

#### Scenario: No agent-only operation
- **WHEN** an agent looks for a way to change mail that the UI does not offer, such as permanent deletion
- **THEN** no tool provides it

### Requirement: Mailbox action tool
`apply_message_actions` SHALL take `{ accountId, items }` with 1 to 100 items of `{ message, subject, action }`, where `action` is `move` (with `destination`), `trash`, `mark_read`, `mark_unread`, `flag` or `unflag`; `leave` SHALL be rejected. It SHALL apply them immediately as a direct action (actions/message-actions) and return the batch with each item's result; the page SHALL attribute the batch to the assistant. Its description SHALL state that Trash never permanently deletes.

#### Scenario: Mixed result
- **WHEN** an agent trashes two messages and one is stale
- **THEN** the tool returns a `partially_applied` batch with one `applied` and one `failed` result

#### Scenario: Leave action
- **WHEN** an agent calls `apply_message_actions` with action `{ type: "leave" }`
- **THEN** the call fails and no request is sent

#### Scenario: Flag for follow-up
- **WHEN** an agent calls `apply_message_actions` with action `{ type: "flag" }` for a current message
- **THEN** the message is flagged and the returned batch is `applied`
