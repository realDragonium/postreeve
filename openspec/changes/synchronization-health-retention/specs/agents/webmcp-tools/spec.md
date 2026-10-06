## MODIFIED Requirements

### Requirement: Fixed tool set without proposal tools
The system SHALL define exactly these tools: `list_accounts`, `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `list_messages`, `read_messages`, `search_messages`, `send_message`, `apply_message_actions`, `list_activity`, `undo_batch`, `inspect_synchronization`, `retry_synchronization`, `request_reauthorization`. Read-only inspection tools SHALL be annotated `readOnlyHint: true`; mutation and recovery request tools SHALL be annotated `readOnlyHint: false`. All SHALL use `untrustedContentHint: true`. No tool SHALL create, update, approve or apply a proposal.

#### Scenario: Agent inspects available tools
- **WHEN** an agent lists the tools of an open Postreeve page with nothing hidden
- **THEN** it sees the fifteen tools above and no proposal tool

## ADDED Requirements

### Requirement: Synchronization tools
`inspect_synchronization` SHALL accept an empty object and return current local account health and retention policy. `retry_synchronization` and `request_reauthorization` SHALL accept an account ID. Retry SHALL schedule safe background work without changing mail; reauthorization SHALL return human authorization instructions and SHALL NOT receive credentials or grant consent. These tools SHALL validate strict inputs and shared outputs and pass cancellation signals to their API requests.

#### Scenario: Agent requests authorization recovery
- **WHEN** an agent requests reauthorization for an account
- **THEN** it receives instructions for the person to use existing Gmail consent or IMAP account settings, without any credential being exposed
