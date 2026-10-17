## MODIFIED Requirements

### Requirement: Trash moves to the provider's Trash and nothing is permanently deleted
The system SHALL apply `trash` by moving the message to the provider's Trash: the IMAP mailbox with the special-use `\Trash` attribute, or Gmail's trash operation. An IMAP account without such a mailbox SHALL fail the item with `This account has no discoverable special-use Trash mailbox`. No action type, proposal or agent tool SHALL permanently delete or expunge a message; only the human-confirmed permanent delete below may. The UI SHALL disable Trash when the account has no Trash folder or the open message is already in Trash.

#### Scenario: Trash an IMAP message
- **WHEN** a person trashes an IMAP message and the account has a `\Trash` mailbox
- **THEN** the message is moved to that mailbox and remains recoverable there

#### Scenario: Message already in Trash
- **WHEN** a person opens a message stored in the Trash folder
- **THEN** the reader's Trash control is disabled and labelled `In Trash`

## ADDED Requirements

### Requirement: Permanent delete from Trash or Junk
`POST /api/messages/delete-permanently` SHALL take `{ accountId, messages, confirm }` with 1 to 100 references of that account and `confirm` equal to `delete permanently`. It SHALL refuse the whole request when any reference is outside the account's special-use Trash or Junk folder, revalidate each reference, and expunge only the named messages. The response SHALL report `{ deleted }`. It SHALL NOT create an Activity batch or undo entry.

#### Scenario: Delete a trashed message
- **WHEN** a person deletes forever a current message in an IMAP account's Trash
- **THEN** the server expunges that UID only and the response reports one deleted message

#### Scenario: Inbox message refused
- **WHEN** a request names a message in the Inbox
- **THEN** the request fails with `Only messages in Trash or Spam can be deleted permanently` and nothing is deleted

### Requirement: Expunge never removes other messages
Without the IMAP `UIDPLUS` extension the system SHALL refuse a permanent delete when the folder holds `\Deleted` messages that were not named, because a plain `EXPUNGE` would remove them too.

#### Scenario: Server without UIDPLUS
- **WHEN** another client has marked a Trash message `\Deleted` and the server lacks `UIDPLUS`
- **THEN** deleting a different Trash message fails and both messages remain

### Requirement: Empty Trash and Spam
`POST /api/accounts/<accountId>/folders/empty` SHALL take `{ path, confirm }`, accept only the account's special-use Trash or Junk folder, expunge every message in it and report `{ deleted }`.

#### Scenario: Empty Trash
- **WHEN** a person empties an IMAP account's Trash holding three messages
- **THEN** the folder is empty and the response reports three deleted messages

### Requirement: Gmail permanent delete is unavailable
For Gmail accounts both endpoints SHALL fail with a message explaining that Postreeve's Gmail access cannot delete permanently and that Gmail removes Trash and Spam after 30 days. The UI SHALL NOT offer the controls for Gmail accounts.

#### Scenario: Gmail Trash open
- **WHEN** a person opens a Gmail account's Trash
- **THEN** no Empty Trash control is shown and the strip explains Gmail's 30-day removal

### Requirement: Permanent delete asks first
The UI SHALL offer **Delete forever** in the reader for a message in Trash or Junk of an IMAP account, and above the list, when that folder is open, **Delete <n> forever** for a selection and **Empty Trash** or **Empty Spam**. Each SHALL open a dialog naming what will be deleted and stating that it cannot be undone, with Cancel focused, and SHALL send the request only after the person chooses the dialog's delete button.

#### Scenario: Cancel
- **WHEN** a person chooses Empty Trash and then Cancel
- **THEN** no request is sent
