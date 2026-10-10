# Spec Delta

## ADDED Requirements

### Requirement: Spam and Not spam are moves to and from the junk folder
The system SHALL treat Spam as a `move` to the account's folder whose `specialUse` is `junk`, and Not spam as a `move` from that folder to the account's inbox; there SHALL be no separate spam action type, so both are audited, report per-item results and are undoable like any move. Postreeve SHALL NOT set IMAP `$Junk` or `$NotJunk` keywords.

#### Scenario: Report an IMAP message as spam
- **WHEN** a person chooses Spam for an inbox message in an IMAP account with a `\Junk` mailbox
- **THEN** the UI sends a `move` whose `destination` is that mailbox's path and the message is listed there

#### Scenario: Undo spam
- **WHEN** a person undoes a Spam batch
- **THEN** the message returns to the folder it was moved from

### Requirement: Gmail spam label handling
For Gmail, moving a message to `SPAM` SHALL add the `SPAM` label and remove the source label and `INBOX`; moving it from `SPAM` to `INBOX` SHALL add `INBOX` and remove `SPAM`.

#### Scenario: Gmail inbox message reported as spam
- **WHEN** a person chooses Spam for a Gmail message in `INBOX`
- **THEN** the message gains `SPAM` and loses `INBOX`

#### Scenario: Gmail not spam
- **WHEN** a person chooses Not spam for a Gmail message in `SPAM`
- **THEN** the message gains `INBOX` and loses `SPAM`

### Requirement: Spam controls in the UI
The reader and the selection toolbar SHALL offer Spam, labelled Not spam when the open message (or, for the selection, the first selected message) is in the junk folder. Spam SHALL be disabled with the title `This account has no Junk folder` when the account has none.

#### Scenario: Not spam from the reader
- **WHEN** a person opens a message in the junk folder and chooses Not spam
- **THEN** the UI sends a `move` to the account's inbox, the status reads `Moved 1 to <inbox path>` and the reader closes

#### Scenario: Account without a junk folder
- **WHEN** the open message's account has no folder with `specialUse` `junk`
- **THEN** the Spam button is disabled with the title `This account has no Junk folder`

### Requirement: Spam keyboard shortcut
The `!` shortcut SHALL send Not spam when the open or focused message is in the junk folder and Spam otherwise, applied to the selection or else that message. It SHALL show `This account has no Junk folder.` instead of acting when there is none, and like other shortcuts it SHALL be ignored with Command, Control or Alt held and while typing.

#### Scenario: Spam with the keyboard
- **WHEN** a person presses `!` on a focused inbox message in an account with a junk folder
- **THEN** the UI sends a `move` whose `destination` is the junk folder's path

#### Scenario: Modifier held
- **WHEN** a person presses `!` with Control held
- **THEN** no action is sent
