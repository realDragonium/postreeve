# Spec Delta

## MODIFIED Requirements

### Requirement: Activity view
The UI SHALL offer an Activity tab with one row per batch operation and per remote agent call that produced no batch, newest first: actor, operation (such as `moved to Archive` or the call's summary), folder and UID or account, relative time, `(undone)` for undone operations and any error. Each `applied` or `partially_applied` batch SHALL offer one Undo button. With no rows it SHALL say `Nothing yet.`; a load error SHALL show `Try again`.

#### Scenario: Undo from Activity
- **WHEN** a person moves a message to Archive, opens Activity and selects Undo
- **THEN** the row reads `moved to Archive (undone)` and no Undo button remains for that batch

#### Scenario: Remote agent prepares a proposal
- **WHEN** an agent named `Claude` creates a proposal over remote MCP
- **THEN** Activity shows a row with actor `Claude` and `create_proposal` with the proposal title

## REMOVED Requirements

### Requirement: Actor attribution is browser-local
**Reason**: Remote agents act without a browser, so the server must record who asked.
**Migration**: See "Actor attribution"; WebMCP and UI attribution stay browser-local as before.

## ADDED Requirements

### Requirement: Actor attribution
The UI SHALL attribute a batch to the remote agent's name when the server's audit names the batch (agents/remote-mcp), to `assistant` when this browser applied it through WebMCP (remembered in browser storage, up to the 500 most recent), to `you` when it was applied through the UI in the current session, and otherwise to `unattributed`, never guessing. Activity SHALL filter rows by All, Assistant (which includes remote agents), You or Unattributed.

#### Scenario: Batch from an earlier session
- **WHEN** a person reloads the page and opens Activity
- **THEN** batches applied through the UI before the reload are shown as unattributed, while those applied through WebMCP in this browser still show `assistant`

#### Scenario: Remote agent batch
- **WHEN** an agent named `ChatGPT` trashes a message over remote MCP and the person opens Activity in any browser
- **THEN** the row's actor is `ChatGPT` and the Assistant filter shows it
