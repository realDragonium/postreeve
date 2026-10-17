## MODIFIED Requirements

### Requirement: Action controls in the web UI
The UI SHALL offer Archive, Mark read or Mark unread, Flag or Unflag, Move to… and Trash for the open message in the reader, and Archive, Mark read, Unread, Flag, Unflag, Move and Trash for the selection (or the focused message when nothing is selected) in the message list, plus the `e` (archive), `u` (toggle read), `Shift+U` (mark unread), `s` (toggle flag) and `#` (Trash) shortcuts (runtime/web-shell). Move destinations SHALL exclude the Trash folder, and in the reader also the message's current folder.

#### Scenario: Reader move menu
- **WHEN** a person opens the Move to… menu for an inbox message
- **THEN** it lists the account's folders except the inbox and Trash

#### Scenario: Flag with the keyboard
- **WHEN** a person presses `s` on a focused unflagged message
- **THEN** the UI sends a `flag` action for that message

#### Scenario: Mark unread with the keyboard
- **WHEN** a person presses `Shift+U` on a focused read message
- **THEN** the UI sends a `mark_unread` action for that message
