# Folders Specification

## Purpose
Covers the folders a person sees for each connected account: listing them with total and unread counts, recognising special folders from provider metadata, managing custom IMAP folders and Gmail labels, and keeping the sidebar's counts and selected mailbox current. Listing the messages inside a folder is specified in mailbox/message-listing; the WebMCP folder tools in agents/webmcp-tools; connecting accounts in accounts/imap-smtp-accounts and accounts/gmail-accounts.

## Requirements

### Requirement: List an account's folders with counts
The system SHALL return the folders of an account at `GET /api/accounts/<accountId>/folders` as an array of `{ path, name, specialUse, unread, total }`, where `path` identifies the folder in later calls, `total` is the provider's message count and `unread` its unread count, both non-negative integers. Every call SHALL read current provider data. An unknown account or a provider failure SHALL answer 400 with `{ error }`.

#### Scenario: Folder counts come from the provider
- **WHEN** a person opens an account whose Inbox holds 12 messages, 3 of them unread
- **THEN** the Inbox entry reports `total` 12 and `unread` 3

#### Scenario: Unknown account
- **WHEN** a client requests the folders of an account ID that is not configured
- **THEN** the response is 400 with an `error` message

### Requirement: IMAP folders and special-use detection
For an IMAP account the system SHALL list every selectable mailbox (omitting `\Noselect`) with counts from the server's message and unseen status, and set `specialUse` to `inbox` for the path `INBOX` in any case, `sent` for `\Sent`, `drafts` for `\Drafts`, `trash` for `\Trash`, `junk` for `\Junk`, `archive` for `\Archive` or `\All`, and `null` otherwise. A folder's name alone SHALL NOT make it special.

#### Scenario: Special-use attributes classify folders
- **WHEN** an IMAP server lists `INBOX`, `Sent Items` marked `\Sent` and `Projects` with no attribute
- **THEN** they are reported with `specialUse` `inbox`, `sent` and `null`

#### Scenario: Non-selectable parent is hidden
- **WHEN** an IMAP server lists a `\Noselect` parent mailbox above selectable children
- **THEN** the parent is absent from the list and its children are present

#### Scenario: Name alone does not make a special folder
- **WHEN** an IMAP mailbox is named `Trash` but carries no `\Trash` attribute
- **THEN** it is listed with `specialUse` `null`

### Requirement: Gmail labels as folders
For a Gmail account the system SHALL list every user label plus the system labels `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM` and `ALL`, named Inbox, Sent, Drafts, Trash, Spam and All mail, with `path` set to the label ID and counts from the label's totals. `SPAM` SHALL have `specialUse` `junk`; `ALL` and user labels SHALL have `specialUse` `null`. Folders SHALL be ordered Inbox, Archive, Drafts, Sent, Trash, Spam, then the rest by name.

#### Scenario: Gmail sidebar order
- **WHEN** a Gmail account has user labels `Receipts` and `Clients`
- **THEN** the folders are listed as Inbox, Archive, Drafts, Sent, Trash, Spam, then All mail, Clients and Receipts by name

### Requirement: Gmail Archive folder
For a Gmail account the system SHALL add a synthetic folder named Archive with `specialUse` `archive` that holds the messages carrying none of the Inbox, Sent, Drafts, Spam or Trash labels. Its `total` SHALL be the All mail total minus the Inbox total and its `unread` SHALL be 0.

#### Scenario: Archive count
- **WHEN** All mail holds 500 messages and Inbox holds 40
- **THEN** Archive reports `total` 460 and `unread` 0

### Requirement: Create a custom folder
The system SHALL create a folder at `POST /api/accounts/<accountId>/folders` with `{ name }`, where `name` is trimmed and 1 to 200 characters, and answer 201 with the account's full updated folder list. On IMAP the name SHALL be used as the new mailbox path; on Gmail it SHALL create a user label that is shown in the label list and message list.

#### Scenario: Create an IMAP folder
- **WHEN** a person creates a folder named `Projects` on an IMAP account
- **THEN** the response is 201 and the returned list contains `Projects` with `specialUse` `null`

#### Scenario: Blank name
- **WHEN** a client submits a name made only of spaces
- **THEN** the request is rejected with 400 and nothing is created

### Requirement: Rename a custom folder
The system SHALL rename a folder at `PUT /api/accounts/<accountId>/folders` with `{ path, name }` (`path` 1 to 1,000 characters, `name` trimmed, 1 to 200 characters) and answer with the full updated folder list. On IMAP the folder SHALL keep its parent path: the new path is the old path up to and including its last hierarchy delimiter followed by `name`, and an unchanged path SHALL be a no-op. On Gmail the label's name SHALL change and its ID, and therefore its `path`, SHALL stay the same.

#### Scenario: Nested IMAP folder keeps its parent
- **WHEN** a person renames the IMAP folder `Projects/Active` to `Current`
- **THEN** `Projects/Current` exists and `Projects/Active` no longer does

#### Scenario: Gmail label rename keeps its path
- **WHEN** a person renames the Gmail label `Label_2` from `Receipts` to `Keep`
- **THEN** the returned list contains path `Label_2` named `Keep`

### Requirement: Delete a custom folder
The system SHALL delete a folder at `DELETE /api/accounts/<accountId>/folders` with a JSON body `{ path }` and answer with the full updated folder list. An IMAP folder SHALL be deleted only when it holds no messages; otherwise the request SHALL fail with "Move every message out of this IMAP folder before deleting it" and the folder SHALL remain. Deleting a Gmail label SHALL remove only the label; its messages SHALL keep their other labels.

#### Scenario: Non-empty IMAP folder
- **WHEN** a person deletes an IMAP folder that still holds one message
- **THEN** the request fails with 400 and the folder and its message remain

#### Scenario: Empty IMAP folder
- **WHEN** a person deletes an empty custom IMAP folder
- **THEN** the folder is removed and absent from the returned list

#### Scenario: Gmail label with messages
- **WHEN** a person deletes a Gmail label applied to messages that are also in Inbox
- **THEN** the label is removed and the messages stay in Inbox

### Requirement: System folders are protected
The system SHALL refuse to rename or delete an IMAP folder with a non-null `specialUse`, a Gmail system label, or the Gmail Archive folder, and SHALL refuse an IMAP path that does not name an existing selectable folder with "Folder <path> does not exist". Each refusal SHALL answer 400 and change nothing at the provider.

#### Scenario: Renaming the Inbox
- **WHEN** a client renames the IMAP folder `INBOX`
- **THEN** the request fails with "System and special-use folders cannot be changed"

#### Scenario: Deleting a Gmail system label
- **WHEN** a client deletes the Gmail folder `INBOX`
- **THEN** the request fails with "System Gmail labels cannot be changed"

#### Scenario: Renaming the Gmail Archive
- **WHEN** a client renames the Gmail Archive folder
- **THEN** the request fails with "System and synthetic folders cannot be changed"

### Requirement: Manage folders sheet
The web interface SHALL offer **Manage folders** for each account, listing every folder with its message count and kind. Folders with a `specialUse` SHALL be marked Protected and offer no rename or delete. Custom folders SHALL offer Rename and Delete; for IMAP accounts Delete SHALL be disabled while the folder's `total` is above zero. Delete SHALL ask for confirmation, and a failed operation SHALL show the provider's error in the sheet.

#### Scenario: Protected folder
- **WHEN** a person opens Manage folders for an account
- **THEN** Inbox and other special folders show Protected without Rename or Delete

#### Scenario: Non-empty IMAP folder cannot be deleted from the sheet
- **WHEN** an IMAP custom folder has a `total` of 4
- **THEN** its Delete button is disabled with a hint to move every message out first

### Requirement: Sidebar shows folders and counts
The web interface SHALL list each account's folders in the sidebar with the folder's unread count (when above zero) and total. Each account heading SHALL show its Inbox unread count. When more than one account is connected, a Unified group SHALL offer one row each for Inbox, Archive, Sent, Drafts, Spam and Trash, summing the matching special folders across accounts; a row other than Inbox SHALL appear only when its summed total is above zero.

#### Scenario: Unified counts
- **WHEN** two accounts have Inbox unread counts of 2 and 5
- **THEN** the Unified Inbox row shows 7 unread

#### Scenario: Empty unified folder is hidden
- **WHEN** no connected account has any message in a Spam folder
- **THEN** the Unified group shows no Spam row, while Inbox is always shown

### Requirement: Folder counts refresh while the page is open
The web interface SHALL refetch every account's folder list every 15 seconds while the page is open, and after each mailbox action, undo, accepted proposal or sent message, so that counts reflect changes made elsewhere.

#### Scenario: External change appears
- **WHEN** a new message arrives in the Inbox from another client while Postreeve is open
- **THEN** the Inbox counts update within about 15 seconds without a reload

### Requirement: The selected mailbox stays valid after folder changes
When a folder change made through Manage folders affects the selected folder, the web interface SHALL keep a valid selection: after a rename it SHALL select the renamed folder, and after a delete it SHALL select another folder of that account. On first load it SHALL select the Unified Inbox when more than one account is connected, otherwise the only account's Inbox. Folder changes made by WebMCP tools follow agents/webmcp-tools.

#### Scenario: Renaming the open folder
- **WHEN** a person renames the folder they are viewing from `Receipts` to `Keep`
- **THEN** the message list shows `Keep` without the person reselecting it

#### Scenario: Deleting the open folder
- **WHEN** a person deletes the folder they are viewing
- **THEN** the view switches to another folder of the same account
