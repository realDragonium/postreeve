# Message Listing Specification

## Purpose
Covers listing and searching message summaries within a folder, the fields each summary carries, and how the web interface filters, sorts, extends and refreshes the visible list, including the Unified view across accounts. Folders and their counts are specified in mailbox/folders; full bodies and attachments in mailbox/message-reading; how one message keeps a single identity across folders, accounts and duplicate deliveries in conversations/message-identity; conversation grouping in conversations/conversation-threading.

## Requirements

### Requirement: List the newest messages in a folder
The system SHALL return at most `limit` of a folder's newest messages, read from the provider at request time, at `GET /api/accounts/<accountId>/messages?mailbox=<path>&limit=<n>`, where `mailbox` is required and `limit` is an integer from 1 to 100, default 50. On IMAP these SHALL be the highest UIDs, highest first; on Gmail the label's first page in Gmail's order. An invalid parameter, unknown account or provider failure SHALL answer 400 with `{ error }`.

#### Scenario: Default page size
- **WHEN** a client lists a folder of 300 messages without `limit`
- **THEN** at most 50 summaries are returned, newest first

#### Scenario: Limit above the maximum
- **WHEN** a client requests `limit=101`
- **THEN** the response is 400 and the provider is not queried

### Requirement: Search within a folder
When `query` (trimmed, at most 200 characters) is present, the system SHALL return at most `limit` of the newest messages in that one folder that match it, searched by the provider at request time. On IMAP a message SHALL match when the query appears in its subject, From, To or body text. On Gmail the query SHALL be run as a Gmail search restricted to the folder's label, or to the Archive selection for the Archive folder.

#### Scenario: IMAP search
- **WHEN** a person searches the IMAP Inbox for `invoice`
- **THEN** only Inbox messages whose subject, sender, recipients or text contain `invoice` are returned, newest first

#### Scenario: Gmail search in Archive
- **WHEN** a person searches the Gmail Archive folder for `from:alex`
- **THEN** the results match `from:alex` and carry none of the Inbox, Sent, Drafts, Spam or Trash labels

#### Scenario: Overlong query
- **WHEN** a client sends a 201-character query
- **THEN** the response is 400

### Requirement: Summary fields
Each summary SHALL carry `ref` (the provider location used by later reads and actions), `messageId`, `subject`, `from`, `to`, `cc`, `replyTo`, `receivedAt`, `preview`, `read`, `flagged`, `canonicalId`, `canonicalAliases` and `conversationId`. A missing subject SHALL be reported as `(no subject)`. `receivedAt` SHALL be an ISO timestamp from the provider's received date, falling back to the Date header.

#### Scenario: Message without a subject
- **WHEN** a listed message has no Subject header
- **THEN** its summary's `subject` is `(no subject)`

### Requirement: Read state, flag and preview
A summary's `read` SHALL reflect the provider's seen state (`\Seen` on IMAP, absence of `UNREAD` on Gmail) and `flagged` its flag (`\Flagged` on IMAP, `STARRED` on Gmail). On IMAP `preview` SHALL be the first 240 characters of the body text with whitespace collapsed; on Gmail it SHALL be Gmail's snippet.

#### Scenario: Unread starred Gmail message
- **WHEN** a listed Gmail message has the labels `UNREAD` and `STARRED`
- **THEN** its summary has `read` false and `flagged` true

### Requirement: Catch-all delivery addresses
A summary SHALL carry `deliveredTo`, the email addresses the message was delivered to. On IMAP these SHALL be taken from the `Delivered-To`, `X-Original-To` and `Envelope-To` headers, lowercased and de-duplicated, and `deliveredTo` SHALL be omitted when none is found. On Gmail they SHALL be taken from the `Delivered-To` header. Values that are not valid email addresses SHALL be dropped. `deliveredTo` SHALL be kept separate from the visible `to` and `cc` recipients.

#### Scenario: Catch-all alias
- **WHEN** a message addressed to `human@example.test` arrives with `Delivered-To: catchall+sales@example.test`
- **THEN** `to` contains only `human@example.test` and `deliveredTo` is `["catchall+sales@example.test"]`

#### Scenario: Bcc delivery
- **WHEN** a message with no visible recipients arrives with `Delivered-To: private@example.test`
- **THEN** `to` is empty and `deliveredTo` is `["private@example.test"]`

#### Scenario: Malformed delivery header
- **WHEN** an IMAP message's only delivery header is `Delivered-To: not-an-address`
- **THEN** its summary has no `deliveredTo`

### Requirement: One summary per canonical message
A list or search response SHALL contain at most one summary per canonical message, even when the provider returns several deliveries of the same message, as defined in conversations/message-identity.

#### Scenario: Duplicate delivery in one folder
- **WHEN** a folder holds two provider copies of the same message
- **THEN** the list response contains one summary for it

### Requirement: Unified view lists across accounts
When more than one account is connected, the web interface SHALL offer a Unified view per special folder that lists the matching special folder of every account that has one, with the same query and limit, and merges the results into one list. The merged list SHALL show each canonical message once. Each row SHALL show its account's colour, and searching in the Unified view SHALL search every account.

#### Scenario: Unified Inbox
- **WHEN** a person with a Gmail and an IMAP account opens the Unified Inbox
- **THEN** the list combines both Inboxes, newest first

### Requirement: Filter the visible list
The web interface SHALL offer the filters All, Unread and Flagged. Unread SHALL keep messages with `read` false and Flagged messages with `flagged` true. Filters SHALL apply to the summaries already loaded for the current folder and query, not to the whole folder at the provider.

#### Scenario: Unread filter
- **WHEN** a person selects Unread in a folder whose 50 loaded messages include 3 unread
- **THEN** the list shows those 3 messages and the count line ends with `unread only`

### Requirement: Sort the visible list
The web interface SHALL offer the sort orders Newest (default), Oldest, Sender and Subject over the loaded summaries. Newest and Oldest SHALL order by `receivedAt`, Sender by the first sender's display name or, without one, its address, and Subject by subject text.

#### Scenario: Oldest first
- **WHEN** a person selects Oldest
- **THEN** the loaded messages are shown with the earliest `receivedAt` first

### Requirement: Search from the web interface
The web interface SHALL run a search when the person presses Enter in the search field, sending the trimmed text as `query` for every folder in the current view and resetting the page size to 50. Clearing the field SHALL return to the unsearched list. The `/` key SHALL focus the search field.

#### Scenario: Search the open folder
- **WHEN** a person types `quarterly planning` in the search field and presses Enter
- **THEN** the list shows the folder's matching messages and the count line includes `matching “quarterly planning”`

### Requirement: Load more messages up to 100
The web interface SHALL load 50 messages per folder at first and SHALL offer **Load 50 more** while a folder returned as many messages as requested and fewer than 100 were requested, raising the limit to at most 100. Choosing another folder or submitting a search SHALL reset the limit to 50.

#### Scenario: Second page
- **WHEN** a person chooses Load 50 more in a folder of 300 messages
- **THEN** the list shows the newest 100 messages and the button disappears

### Requirement: List states and count line
The web interface SHALL show placeholder rows while loading, a provider error with **Try again** when listing fails, and, for an empty result, "This folder is clear. New messages will appear here." or, when a search or filter is active, "Nothing matches. Clear the search or switch the filter back to All." A count line SHALL state the number of shown messages and how many are unread, and name the active query and filter.

#### Scenario: Listing fails
- **WHEN** the provider is unreachable while a folder is opened
- **THEN** the list shows the error message with a Try again control that requests the list again

#### Scenario: Empty search
- **WHEN** a search returns no messages
- **THEN** the list shows "Nothing matches. Clear the search or switch the filter back to All."

### Requirement: The list refreshes after changes
The web interface SHALL request the visible message lists again after a mailbox action, undo or accepted proposal completes, after a folder is created, renamed or deleted, after **Try again**, and after a message is sent. The message list is not polled on a timer.

#### Scenario: Moved message leaves the list
- **WHEN** a person moves a message from Inbox to Archive
- **THEN** the Inbox list is requested again and no longer shows the message
