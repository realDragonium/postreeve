## MODIFIED Requirements

### Requirement: Undo reverses each applied operation
For every operation with status `applied`, undo SHALL reverse it at the provider and mark it `undone`: `mark_read` and `mark_unread` restore the recorded read state; `flag` and `unflag` the recorded flag state; `move` returns the message to its original folder (in Gmail by restoring its labels); `trash` moves an IMAP message back or untrashes a Gmail message. A failed reversal SHALL mark that operation `undo_failed` with the error, and the remaining operations SHALL still be attempted.

#### Scenario: Undo mark read
- **WHEN** a person undoes a batch that marked an unread message read
- **THEN** the message is unread again and the operation is `undone`

#### Scenario: Undo flag
- **WHEN** a person undoes a batch that flagged an unflagged message
- **THEN** the message is unflagged again, leaves the Flagged filter and the operation is `undone`

#### Scenario: Undo a Trash
- **WHEN** a person undoes a batch that trashed an inbox message
- **THEN** the message is back in the inbox
