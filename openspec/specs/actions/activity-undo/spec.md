# Activity and Undo Specification

## Purpose
Covers the audit trail of applied mailbox actions and their undo: listing operation batches per account, batch and operation statuses, what undo reverses and what it cannot, and the Activity view in the UI. How batches are produced is specified in actions/message-actions and actions/proposals; the agent-facing `list_activity` and `undo_batch` tools in agents/webmcp-tools.

## Requirements

### Requirement: Batches are listed per account
The system SHALL return at `GET /api/batches?accountId=<id>` every operation batch recorded for that account, newest created first. Each batch SHALL carry `id`, `proposalId`, `accountId`, `status`, `operations`, `createdAt` and `updatedAt`, and each operation `itemId`, `message`, `action`, `status` and `error`. The provider data kept for undo SHALL NOT be returned. An unknown account SHALL be refused with 400 `Account not found`.

#### Scenario: Two actions on one account
- **WHEN** a person marks a message read and later moves another message
- **THEN** the account's batch list returns the move batch first and the mark-read batch second

#### Scenario: Unknown account
- **WHEN** a client requests batches for an account ID that does not exist
- **THEN** the response is 400 `Account not found`

### Requirement: Batch and operation statuses
A batch `status` SHALL be one of `applied`, `partially_applied`, `failed`, `undone` or `partially_undone`, and an operation `status` one of `applied`, `failed`, `undone`, `undo_failed` or `not_undoable`. On apply, the batch SHALL be `applied` when every operation applied, `failed` when none did, and `partially_applied` otherwise. After undo, the batch SHALL be `undone` when every operation that undo attempted was undone, and `partially_undone` when any of them is `undo_failed`.

#### Scenario: Undo with one provider failure
- **WHEN** a batch with two applied operations is undone and the provider refuses one reversal
- **THEN** the batch is `partially_undone` with one operation `undone` and one `undo_failed` carrying the provider's error

### Requirement: Only an applied batch can be undone, once
The system SHALL undo a batch through `POST /api/batches/<batchId>/undo` and answer with the updated batch. Undo SHALL be accepted only for a batch whose status is `applied` or `partially_applied`; any other batch SHALL be refused with 400 `Only an applied batch can be undone`, and an unknown batch with 400 `Operation batch not found`. A batch SHALL therefore be undone at most once, and an `undo_failed` operation SHALL NOT be retried.

#### Scenario: Undo twice
- **WHEN** a client undoes a batch that is already `undone`
- **THEN** the response is 400 `Only an applied batch can be undone` and no mail changes

#### Scenario: Failed batch
- **WHEN** a client undoes a batch whose status is `failed`
- **THEN** the response is 400

### Requirement: Undo reverses each applied operation
For every operation with status `applied`, undo SHALL reverse it at the provider and mark it `undone`: `mark_read` and `mark_unread` restore the read state recorded before the action; `move` returns the message to its original folder (in Gmail by restoring its labels); `trash` moves an IMAP message back or untrashes a Gmail message. A failed reversal SHALL mark that operation `undo_failed` with the error, and the remaining operations SHALL still be attempted.

#### Scenario: Undo mark read
- **WHEN** a person undoes a batch that marked an unread message read
- **THEN** the message is unread again and the operation is `undone`

#### Scenario: Undo a Trash
- **WHEN** a person undoes a batch that trashed an inbox message
- **THEN** the message is back in the inbox

### Requirement: IMAP undo refuses to act on changed mail
For IMAP, undo SHALL reverse an operation only when the message is still at the UID (and MODSEQ, when recorded) the action left it with, and, for a move or Trash, only when the original mailbox's UIDVALIDITY is unchanged. Otherwise the operation SHALL become `undo_failed`.

#### Scenario: Original folder recreated
- **WHEN** a moved message's original IMAP mailbox has a different UIDVALIDITY at undo time
- **THEN** the operation is `undo_failed` with an error naming that the mailbox changed, and the message stays where it is

### Requirement: What undo does not reverse
Undo SHALL leave `failed` operations as `failed` and SHALL NOT re-attempt them. An applied operation with no provider effect (a proposal's `leave` item) SHALL become `not_undoable`. Operations whose status is `not_undoable` or `failed` SHALL NOT count against an `undone` batch status. Because no action permanently deletes mail, there is no permanent deletion to undo.

#### Scenario: Partially applied batch
- **WHEN** a `partially_applied` batch with one applied and one failed operation is undone
- **THEN** the applied operation becomes `undone`, the failed one stays `failed`, and the batch is `undone`

### Requirement: Undo keeps message identity and the proposal in step
When undo moves a message back, the system SHALL retain its local identity at the restored location; if that fails, the operation SHALL stay `undone` with an `error` warning. After undo, the proposal that produced the batch SHALL take the batch's new status (`undone` or `partially_undone`).

#### Scenario: Proposal follows its batch
- **WHEN** a person undoes the batch of an applied proposal
- **THEN** listing the account's proposals shows that proposal as `undone`

### Requirement: Activity view
The UI SHALL offer an Activity tab listing one row per operation from every account's batches, newest updated batch first, with actor, operation (such as `moved to Archive` or `marked read`), folder and UID, relative time, an `(undone)` suffix for undone operations and any error. Each batch whose status is `applied` or `partially_applied` SHALL offer one Undo button. With no batches it SHALL say `Nothing yet.`; a load error SHALL be shown with `Try again`.

#### Scenario: Undo from Activity
- **WHEN** a person moves a message to Archive, opens Activity and selects Undo
- **THEN** the row reads `moved to Archive (undone)` and no Undo button remains for that batch

### Requirement: Actor attribution is browser-local
The server SHALL NOT record who requested a batch. The UI SHALL attribute a batch to `assistant` when this browser applied it through WebMCP (remembered in browser storage, up to the 500 most recent), to `you` when it was applied through the UI in the current session, and otherwise to `unattributed`, never guessing. Activity SHALL filter rows by All, Assistant, You or Unattributed.

#### Scenario: Batch from an earlier session
- **WHEN** a person reloads the page and opens Activity
- **THEN** batches applied through the UI before the reload are shown as unattributed, while those applied through WebMCP in this browser still show `assistant`

### Requirement: Session undo
The UI SHALL keep an undo list of up to 8 entries for direct actions and accepted proposals applied in the current page session. Cmd+Z or Ctrl+Z (outside text fields) and the status bar's `Undo ⌘Z` button SHALL undo the most recent entry, undoing every batch it holds (one per account), then remove it and show `Reverted`.

#### Scenario: Undo the last bulk action
- **WHEN** a person archives a selection spanning two accounts and presses Cmd+Z
- **THEN** both resulting batches are undone and the status reads `Reverted`

### Requirement: History lives as long as the account
The system SHALL keep batches and proposals until their account is removed, and removing an account SHALL delete its batches and proposals without changing provider mail.

#### Scenario: Account removed
- **WHEN** a person removes an account
- **THEN** its batches and proposals are deleted and mail at the provider is untouched
