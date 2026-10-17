## MODIFIED Requirements

### Requirement: WebMCP mirrors user workflows
Every tool SHALL perform an operation a person can perform in the web UI, through Postreeve's server API, and SHALL NOT introduce an agent-only workflow or capability. Where the UI can do more than a tool, the tool SHALL offer the narrower operation rather than a different one.

#### Scenario: No agent-only operation
- **WHEN** an agent looks for a way to change mail that the UI does not offer
- **THEN** no tool provides it

## ADDED Requirements

### Requirement: No permanent delete tool
No WebMCP tool SHALL delete a message permanently or empty a folder, and `apply_message_actions` SHALL NOT accept an action that does. Permanent deletion requires a human confirmation in the UI.

#### Scenario: Tool list inspected
- **WHEN** the registered tools and their input schemas are inspected
- **THEN** none can permanently delete mail or empty a folder
