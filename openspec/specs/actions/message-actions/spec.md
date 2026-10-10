# Message Actions Specification

## Purpose
Covers the direct mailbox actions a person applies to messages: mark read, mark unread, flag, unflag, archive, Spam and Not spam, move and Trash, through the web UI and `POST /api/messages/actions`. The audited batch each request produces, and its undo, are specified in actions/activity-undo; proposals in actions/proposals; unsubscribing in actions/unsubscribe; the same actions for agents in agents/webmcp-tools; folder management in mailbox/folders; how message identity follows a moved message in conversations/message-identity.

## Requirements

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

### Requirement: One account per batch
The system SHALL apply a direct action request to exactly one account. Every item's `message.accountId` MUST equal the request's `accountId`; otherwise the request SHALL be refused with 400 `Every direct action must belong to the selected account` before any item is applied. An unknown `accountId` SHALL be refused with 400 `Account not found`. When the UI applies one action to a selection that spans several accounts, it SHALL send one request per account.

#### Scenario: Item from another account
- **WHEN** a request for account A contains an item whose reference belongs to account B
- **THEN** the response is 400 and no item of the request is applied

#### Scenario: Unified selection across two accounts
- **WHEN** a person archives a selection containing messages from two accounts in the unified view
- **THEN** the UI sends two requests, one per account, and records one batch for each

### Requirement: Folder actions resolve per message in the UI
For Archive, Spam and Not spam on a selection, the UI SHALL resolve each message's destination from its own account's folders and SHALL skip messages for which the action is a no-op: already in the archive folder for Archive, already in the junk folder for Spam, and outside the junk folder for Not spam. The status SHALL read `Moved <n> to Archive`, `Moved <n> to Spam` or `Moved <n> to Inbox` with the number moved.

#### Scenario: Unified spam across a Gmail and an IMAP account
- **WHEN** a person selects a Gmail and an IMAP inbox message in the unified Inbox and presses `!`
- **THEN** the Gmail request moves its message to `SPAM` and the IMAP request moves its message to that account's `\Junk` mailbox

### Requirement: A failing account does not lose the others' undo
When the UI sends one request per account and some of them fail, it SHALL still record an undo entry holding the batches that were created and SHALL report the number of failed accounts and their errors in the status. Only when every request fails SHALL the action be reported as a failure without an undo entry.

#### Scenario: One account's request fails
- **WHEN** a selection spans two accounts and the request for one of them fails
- **THEN** the other account's batch is added to the undo list and the status names the failure

### Requirement: Stable references are revalidated before each action
Before applying each item the system SHALL revalidate its reference against the provider: for IMAP the folder's UIDVALIDITY MUST match, the UID MUST exist and, when the reference carries a `modseq`, the message's MODSEQ MUST equal it; for Gmail the message MUST exist and, when the reference carries a `modseq`, its `historyId` MUST equal it. An item that fails revalidation SHALL be recorded as `failed` with error `Message is stale, changed, or missing` and its message SHALL NOT be changed.

#### Scenario: Message changed since it was listed
- **WHEN** an item's reference carries a `modseq` that no longer matches the provider
- **THEN** that operation is `failed` with error `Message is stale, changed, or missing`
- **AND** the message's read state and folder are unchanged

### Requirement: Items succeed or fail individually
The system SHALL attempt every item in request order, and a failure of one item SHALL NOT prevent or undo the others. Each operation result SHALL carry `itemId`, `message`, `action`, `status` (`applied` or `failed`) and `error` (the provider's message for a failure, otherwise null or a warning). The batch `status` SHALL be `applied` when every item applied, `failed` when none did, and `partially_applied` otherwise.

#### Scenario: One stale and one current message
- **WHEN** a request marks a current message and a stale message read
- **THEN** the batch is `partially_applied` with operation statuses `applied` then `failed`
- **AND** the stale message remains unread

### Requirement: Every direct action is recorded as an audited batch
The system SHALL record each direct action request as a proposal titled `Direct mailbox action` (or `Direct mailbox actions` for several items) with item reason `Requested directly through Postreeve.`, mark it approved, apply it and persist the resulting batch with that proposal's ID. The batch SHALL then be listed in Activity and be undoable as specified in actions/activity-undo.

#### Scenario: Direct move appears in activity
- **WHEN** a person moves a message to Archive
- **THEN** `GET /api/batches?accountId=<account>` lists a batch for that move whose `proposalId` names an approved proposal

### Requirement: Read-state actions
The system SHALL apply `mark_read` and `mark_unread` by setting or clearing the provider's read state (the IMAP `\Seen` flag, the Gmail `UNREAD` label) without moving the message, and SHALL record the message's previous read state so the action can be undone.

#### Scenario: Mark unread in Gmail
- **WHEN** a person marks a read Gmail message unread
- **THEN** the Gmail message gains the `UNREAD` label and stays in its folder

### Requirement: Move actions
The system SHALL apply `move` by moving the message to the folder path in `destination` (IMAP moves it to that mailbox; Gmail adds the destination label and removes the source label) and SHALL retain the message's local identity at its new location. When the provider move succeeds but the identity cannot be retained, the operation SHALL stay `applied` and undoable, with an `error` warning that begins `Provider action succeeded, but local message identity could not be retained`.

#### Scenario: Move to a custom folder
- **WHEN** a person moves an inbox message to `Clients`
- **THEN** the message is listed in `Clients`, no longer in the inbox, and keeps its canonical ID

#### Scenario: Identity cannot be retained
- **WHEN** a provider move succeeds but recording the new location fails
- **THEN** the operation is `applied` with an `error` warning and the batch can still be undone

### Requirement: Archive is a move to the account's archive folder
The system SHALL treat archiving as a `move` to the account's folder whose `specialUse` is `archive`; there SHALL be no separate archive action. For Gmail, the archive folder is the synthetic path `__archive__`, and moving there removes `INBOX` and the source label, which undo restores as the message carried them. The UI SHALL disable Archive when no targeted account has an archive folder, and `e` SHALL then show `This account has no Archive folder.` instead of acting.

#### Scenario: Archive with the keyboard
- **WHEN** a person presses `e` on a focused message in an account with an archive folder
- **THEN** the UI sends a `move` action whose `destination` is that folder's path

#### Scenario: Undo a Gmail archive from a label
- **WHEN** a person archives a Gmail message carrying `INBOX` and `Clients` from the `Clients` view and undoes it
- **THEN** the message carries `INBOX` and `Clients` again

#### Scenario: Account without an archive folder
- **WHEN** the open message's account has no folder with `specialUse` `archive`
- **THEN** the Archive button is disabled with the title `This account has no Archive folder`

### Requirement: Trash moves to the provider's Trash and nothing is permanently deleted
The system SHALL apply `trash` by moving the message to the provider's Trash: the IMAP mailbox with the special-use `\Trash` attribute, or Gmail's trash operation. An IMAP account without such a mailbox SHALL fail the item with `This account has no discoverable special-use Trash mailbox`. No action, endpoint or tool SHALL permanently delete or expunge a message. The UI SHALL disable Trash when the account has no Trash folder or the open message is already in Trash.

#### Scenario: Trash an IMAP message
- **WHEN** a person trashes an IMAP message and the account has a `\Trash` mailbox
- **THEN** the message is moved to that mailbox and remains recoverable there

#### Scenario: Message already in Trash
- **WHEN** a person opens a message stored in the Trash folder
- **THEN** the reader's Trash control is disabled and labelled `In Trash`

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

### Requirement: Spam and Not spam are moves to and from the junk folder
The system SHALL treat Spam as a `move` to the account's folder whose `specialUse` is `junk`, and Not spam as a `move` from that folder to the account's inbox; there SHALL be no separate spam action type, so both are audited, report per-item results and are undoable like any move. Postreeve SHALL NOT set IMAP `$Junk` or `$NotJunk` keywords.

#### Scenario: Report an IMAP message as spam
- **WHEN** a person chooses Spam for an inbox message in an IMAP account with a `\Junk` mailbox
- **THEN** the UI sends a `move` whose `destination` is that mailbox's path and the message is listed there

#### Scenario: Undo spam
- **WHEN** a person undoes a Spam batch
- **THEN** the message returns to the folder it was moved from

### Requirement: Gmail spam label handling
For Gmail, moving a message to `SPAM` SHALL add the `SPAM` label and remove only `INBOX`, keeping user labels as Gmail's own Report spam does; undoing it SHALL remove `SPAM` and restore `INBOX` when the message carried it. Moving a message from `SPAM` to `INBOX` SHALL add `INBOX` and remove `SPAM`.

#### Scenario: Gmail inbox message reported as spam
- **WHEN** a person chooses Spam for a Gmail message in `INBOX`
- **THEN** the message gains `SPAM` and loses `INBOX`

#### Scenario: Gmail spam from a label view and undo
- **WHEN** a person reports a Gmail message carrying `INBOX` and `Clients` as spam from the `Clients` view, then undoes it
- **THEN** the message first carries `SPAM` and `Clients`, and after the undo `INBOX` and `Clients`

#### Scenario: Gmail not spam
- **WHEN** a person chooses Not spam for a Gmail message in `SPAM`
- **THEN** the message gains `INBOX` and loses `SPAM`

### Requirement: Spam controls in the UI
The reader and the selection toolbar SHALL offer Spam, labelled Not spam when the open message (or, for the selection, the first selected message) is in the junk folder. Spam SHALL be disabled with the title `This account has no Junk folder` when no targeted message's account has one.

#### Scenario: Not spam from the reader
- **WHEN** a person opens a message in the junk folder and chooses Not spam
- **THEN** the UI sends a `move` to the account's inbox, the status reads `Moved 1 to <inbox path>` and the reader closes

#### Scenario: Account without a junk folder
- **WHEN** the open message's account has no folder with `specialUse` `junk`
- **THEN** the Spam button is disabled with the title `This account has no Junk folder`

#### Scenario: Not spam on a mixed selection
- **WHEN** the first selected message is in the junk folder, another selected message is in the inbox, and the person chooses Not spam
- **THEN** only the junk message is moved to its account's inbox and the inbox message is left in place

### Requirement: Spam keyboard shortcut
The `!` shortcut SHALL send Not spam when the open or focused message is in the junk folder and Spam otherwise, applied to the selection or else that message, resolved per message as for the selection toolbar. It SHALL show `This account has no Junk folder.` instead of acting when no message can be moved because its account has none, and like other shortcuts it SHALL be ignored with Command, Control or Alt held and while typing.

#### Scenario: Spam with the keyboard
- **WHEN** a person presses `!` on a focused inbox message in an account with a junk folder
- **THEN** the UI sends a `move` whose `destination` is the junk folder's path and the status reads `Moved 1 to Spam`

#### Scenario: Modifier held
- **WHEN** a person presses `!` with Control held
- **THEN** no action is sent
