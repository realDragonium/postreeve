# Spec Delta

## ADDED Requirements

### Requirement: Spam handling and no unsubscribe tool
The `apply_message_actions` description SHALL state that reporting spam is a `move` to the account's folder with `specialUse` `junk` and that Not spam is a `move` from it to the inbox. No WebMCP tool SHALL unsubscribe from a mailing list, because unsubscribing requires a human confirmation in the UI. `read_messages` MAY return the parsed `unsubscribe` options.

#### Scenario: Agent reports spam
- **WHEN** an agent calls `apply_message_actions` with a `move` to the junk folder's path
- **THEN** the message is moved there and the batch is audited and undoable

#### Scenario: Agent asked to unsubscribe
- **WHEN** the tool list is inspected
- **THEN** no tool performs an unsubscribe
