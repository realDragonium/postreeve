## MODIFIED Requirements

### Requirement: What undo does not reverse
Undo SHALL leave `failed` operations as `failed` and SHALL NOT re-attempt them. An applied operation with no provider effect (a proposal's `leave` item) SHALL become `not_undoable`. Operations whose status is `not_undoable` or `failed` SHALL NOT count against an `undone` batch status. No action type permanently deletes mail; the separate permanent delete (actions/message-actions) creates no batch and cannot be undone.

#### Scenario: Partially applied batch
- **WHEN** a `partially_applied` batch with one applied and one failed operation is undone
- **THEN** the applied operation becomes `undone`, the failed one stays `failed`, and the batch is `undone`

#### Scenario: After a permanent delete
- **WHEN** a person empties Trash
- **THEN** Activity shows no new batch and no undo entry is offered
