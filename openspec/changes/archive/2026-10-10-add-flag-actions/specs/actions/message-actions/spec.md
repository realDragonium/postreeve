## ADDED Requirements

### Requirement: Flag actions
The system SHALL apply `flag` and `unflag` by setting or clearing the provider's flag (the IMAP `\Flagged` flag, the Gmail `STARRED` label) without moving the message or changing its read state, and SHALL record the message's previous flag state so the action can be undone. A confirmed flag change SHALL update the local index so the `flagged` list filter reflects it without waiting for synchronization.

#### Scenario: Flag an IMAP message
- **WHEN** a person flags an unflagged IMAP inbox message
- **THEN** the message gains `\Flagged`, stays in the inbox with its read state unchanged, and appears under the Flagged filter

#### Scenario: Unflag in Gmail
- **WHEN** a person unflags a starred Gmail message
- **THEN** the message loses the `STARRED` label and no longer appears under the Flagged filter

### Requirement: Flag toggle and mark in the UI
The `s` shortcut SHALL send `unflag` to the selection, or else the open or focused message, when that open or focused message is flagged, and `flag` otherwise. A flagged row in the message list SHALL show `⚑` when no proposal mark occupies that column.

#### Scenario: Flagged row
- **WHEN** a flagged message without a proposal is listed
- **THEN** its row shows `⚑`

## MODIFIED Requirements

### Requirement: Direct action request
The system SHALL accept `POST /api/messages/actions` with `{ accountId, items }`, where `items` holds 1 to 100 entries of `{ message, subject, action }`, `message` is a stable message reference and `action` is one of `{ type: "mark_read" }`, `{ type: "mark_unread" }`, `{ type: "flag" }`, `{ type: "unflag" }`, `{ type: "move", destination }` or `{ type: "trash" }`. It SHALL answer 200 with the resulting operation batch. An invalid request SHALL be answered 400 and SHALL change no mail.

#### Scenario: Mark one message read
- **WHEN** the UI posts one item with action `mark_read` for a current unread message
- **THEN** the response is 200 with a batch whose `status` is `applied` and whose single operation has `status` `applied`
- **AND** the message is read at the provider

#### Scenario: Too many items
- **WHEN** a request contains 101 items
- **THEN** the response is 400 and no message is changed

#### Scenario: Unknown action type
- **WHEN** a client posts an item with action `{ type: "delete" }`
- **THEN** the response is 400 and no message is changed

### Requirement: Action controls in the web UI
The UI SHALL offer Archive, Mark read or Mark unread, Flag or Unflag, Move to… and Trash for the open message in the reader, and Archive, Mark read, Unread, Flag, Unflag, Move and Trash for the selection (or the focused message when nothing is selected) in the message list, plus the `e` (archive), `u` (toggle read) and `s` (toggle flag) shortcuts. Move destinations SHALL exclude the Trash folder, and in the reader also the message's current folder.

#### Scenario: Reader move menu
- **WHEN** a person opens the Move to… menu for an inbox message
- **THEN** it lists the account's folders except the inbox and Trash

#### Scenario: Flag with the keyboard
- **WHEN** a person presses `s` on a focused unflagged message
- **THEN** the UI sends a `flag` action for that message

### Requirement: Feedback after a UI action
After a successful action the UI SHALL clear the selection, close the reader for a move or Trash, show a status (`Moved <n> to <folder>`, `Moved <n> to Trash`, `Marked <n> read`, `Marked <n> unread`, `Flagged <n>` or `Unflagged <n>`), add an undo entry and refresh the mailbox, folders and activity. A failed request SHALL show its error message.

#### Scenario: Bulk mark read
- **WHEN** a person selects three messages and chooses Mark read
- **THEN** the status reads `Marked 3 read`, the selection is cleared and the action can be undone

#### Scenario: Move from the reader
- **WHEN** a person chooses `Archive` in the reader's Move to… menu
- **THEN** the status reads `Moved 1 to Archive` and the reader closes

#### Scenario: Flag from the reader
- **WHEN** a person chooses Flag in the reader
- **THEN** the status reads `Flagged 1`, the reader stays open and its control reads `Unflag`

## REMOVED Requirements

### Requirement: Flagging is not available
**Reason**: Flagging for follow-up is now a supported direct action.
**Migration**: Use the `flag` and `unflag` actions specified in "Flag actions".
