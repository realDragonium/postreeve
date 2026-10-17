# Message Listing Specification

## Purpose
Covers listing and searching message summaries within a folder, the fields each summary carries, and how the web interface filters, sorts, extends and refreshes the visible list, including the Unified view across accounts. Folders and their counts are specified in mailbox/folders; full bodies and attachments in mailbox/message-reading; how one message keeps a single identity across folders, accounts and duplicate deliveries in conversations/message-identity; how messages form conversations in conversations/conversation-threading. Grouping the list by those conversations is specified here.

## Requirements

### Requirement: List the newest messages in a folder
The system SHALL serve indexed cursor pages of 1–100 canonical summaries (default 50) for selected account/mailbox sources at POST /api/messages/query. The existing account GET endpoint SHALL retain bounded provider listing for compatibility. Invalid queries or scope-bound cursors SHALL fail with 400.

#### Scenario: Default page size
- **WHEN** a client queries 300 synchronized messages without a limit
- **THEN** the first 50 summaries and a continuation cursor are returned

#### Scenario: Limit above the maximum
- **WHEN** limit 101 is requested
- **THEN** the request fails with 400 before provider access

### Requirement: Search within a folder
Search SHALL match words and quoted phrases as literal case-insensitive text in indexed sender, recipients, subject, headers, preview and bounded body text within the selected sources. Every word SHALL match. Operators SHALL narrow the search, and any other `name:value` word SHALL stay literal. Provider fallback for incomplete coverage SHALL search only the positive free text and SHALL report its limits; operators, filters and dates still apply to its matches.

#### Scenario: Bounded provider fallback
- **WHEN** index coverage is incomplete across many sources or a provider hangs
- **THEN** the query attempts at most 10 fallback calls and waits at most five seconds in total
- **AND** timed-out calls report failure, skipped sources report that fallback was not requested, and late results do not update the index

#### Scenario: Literal search
- **WHEN** a person searches for invoice
- **THEN** only indexed fields containing invoice or reported provider fallback matches are returned

#### Scenario: IMAP search
- **WHEN** invoice is searched in the IMAP Inbox
- **THEN** indexed sender, recipients, subject, headers and retained preview/body fields are matched literally inside Inbox

#### Scenario: Gmail search in Archive
- **WHEN** from:alex is searched in a synchronized Gmail Archive
- **THEN** the indexed query returns messages from alex within the selected Archive locations, using Postreeve's operator rather than Gmail's query language

#### Scenario: Unknown operator stays literal
- **WHEN** `label:urgent` is searched in a synchronized Gmail Archive
- **THEN** the indexed query matches the literal text `label:urgent` within the selected Archive locations

#### Scenario: Quoted operator stays literal
- **WHEN** `"from:alex"` is searched
- **THEN** messages containing the text `from:alex` match, and the sender is not consulted

#### Scenario: Overlong query
- **WHEN** a 201-character query is supplied
- **THEN** the request fails with 400

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
The unified view SHALL send its matching account/mailbox sources to one backend query. The backend SHALL filter, sort, deduplicate canonical identities and paginate the combined results. Rows SHALL retain their representative account colour.

#### Scenario: Unified Inbox
- **WHEN** a person opens Unified Inbox across Gmail and IMAP
- **THEN** one cursor pages the combined canonical results

### Requirement: Filter the visible list
All, Unread and Flagged filters SHALL apply before pagination to every indexed message in the selected sources. Mutable flags SHALL come from a representative matching location. Confirmed Gmail read and flag changes and their undo SHALL update all locations of the same tenant/account/provider message; IMAP flags SHALL remain location-specific.

#### Scenario: Unread filter
- **WHEN** Unread is selected in a synchronized folder
- **THEN** unread messages beyond the initial 100 messages remain reachable

### Requirement: Sort the visible list
Newest and Oldest SHALL order by the first indexed canonical received timestamp, Sender by its first sender name or address, and Subject by its subject. Later duplicate observations SHALL preserve those sort keys. Every order SHALL use canonical identity as a deterministic tie-break; displayed summaries and flags SHALL use a matching location.

#### Scenario: Duplicate arrives between pages
- **WHEN** another account or location synchronizes an existing canonical message with different headers between cursor pages
- **THEN** its sort position remains anchored to the first indexed copy, independently of which matching location is displayed
- **AND** canonical identity merges preserve the retained identity’s anchor; merges and deletions are not a frozen-snapshot guarantee

#### Scenario: Oldest first
- **WHEN** Oldest is selected
- **THEN** the earliest indexed messages are returned first across cursor pages

### Requirement: Search from the web interface
Enter SHALL submit trimmed search text for one backend query across the current view and restart cursor paging. Clearing search SHALL restore the unsearched view. The / key SHALL focus search. While a search is active, the list header SHALL offer **Everywhere**, which runs the same search across every folder of every account. An empty result outside the everywhere scope SHALL suggest searching Everywhere.

#### Scenario: Search the open folder
- **WHEN** quarterly planning is submitted
- **THEN** the count line names the query and the backend returns matching messages

#### Scenario: Widen to everywhere
- **WHEN** a person searches contract in Inbox and selects Everywhere
- **THEN** matches from Archive and from other accounts are listed in one cursor

### Requirement: Load more messages with cursors
The UI SHALL load 50 messages initially and follow nextCursor with Load 50 more until no cursor remains. Changing source, search, filter or sort SHALL restart paging, including when returning to a previously loaded view. Newly synchronized messages SHALL NOT shift the keyset position. Results are not a frozen snapshot.

#### Scenario: Third page
- **WHEN** a person loads twice more in a synchronized folder of 300 messages
- **THEN** 150 distinct messages are visible and another continuation remains

#### Scenario: Second page
- **WHEN** Load 50 more is selected in a synchronized 300-message mailbox
- **THEN** 100 messages are visible and the cursor allows further pages

### Requirement: List states and count line
The UI SHALL show placeholders, actionable request errors and existing empty/count states. It SHALL separately disclose incomplete synchronization, bounded/unavailable or expired body coverage, and failed or limited provider fallback. Cached indexed results SHALL remain usable when fallback fails.

#### Scenario: Provider unavailable
- **WHEN** a provider fallback fails with indexed results available
- **THEN** indexed results remain visible with a coverage warning

#### Scenario: Listing fails
- **WHEN** the backend query fails
- **THEN** the UI displays an error and Try again control

#### Scenario: Empty search
- **WHEN** no indexed or available provider matches are returned
- **THEN** the UI displays the empty-search message together with any incomplete coverage warning

### Requirement: The list refreshes after changes
The web interface SHALL request the visible message lists again after a mailbox action, undo or accepted proposal completes, after a folder is created, renamed or deleted, after **Try again**, after a message is sent, and after mailbox-change events, coalescing events received within one second. The message list is not polled on a timer.

#### Scenario: Moved message leaves the list
- **WHEN** a person moves a message from Inbox to Archive
- **THEN** the Inbox list is requested again and no longer shows the message

#### Scenario: New mail appears
- **WHEN** synchronization commits a new Inbox message while the Inbox is visible
- **THEN** the list is requested again and shows the message without a reload

### Requirement: Bounded searchable content during synchronization
Synchronization SHALL index bounded body text without requiring messages to be opened. Retained preview and body text SHALL obey the account retention policy. Unavailable body observations SHALL preserve retained body text and its original expiry age. Missing or expired content SHALL be reported separately from metadata synchronization coverage; bounds SHALL be disclosed.

#### Scenario: Unopened message
- **WHEN** a message with available bounded body text synchronizes
- **THEN** its retained body text is searchable without opening it

#### Scenario: Retention eviction
- **WHEN** retained text expires or exceeds the account budget
- **THEN** preview/body search no longer finds evicted text, metadata remains searchable and content coverage reports the omission

### Requirement: Cursor isolation
Continuation cursors SHALL be bound to the tenant, mailbox sources, scope, query, filter, sort and grouping. Malformed or mismatched cursors SHALL be rejected before provider access.

#### Scenario: Changed query
- **WHEN** a cursor from one search is reused for another
- **THEN** the request fails instead of continuing a different result set

#### Scenario: Changed grouping
- **WHEN** a cursor from a grouped list is reused for the ungrouped list
- **THEN** the request fails instead of continuing a different result set

### Requirement: Search operators
One shared parser SHALL interpret search text for the web interface, the HTTP API and WebMCP. A leading `-` SHALL negate any word, phrase or operator. Matching SHALL be case-insensitive. Field operators SHALL match literally within one field:
- `from:` matches sender names and addresses.
- `to:` matches To, Cc, Reply-To and delivery addresses.
- `cc:` matches only Cc names and addresses.
- `subject:` matches the subject, and a quoted value keeps its spaces.

#### Scenario: Cc only
- **WHEN** `cc:kim` is searched
- **THEN** a message with kim only in To does not match and a message with kim in Cc does

#### Scenario: Negated sender
- **WHEN** `invoice -from:billing` is searched
- **THEN** messages containing invoice are returned except those whose sender contains billing

### Requirement: State and date operators
The operators below SHALL narrow search:
- `is:unread`, `is:read` and `is:flagged` (alias `is:starred`) match the state of a location in the view.
- `has:attachment` matches messages whose retained headers declare `multipart/mixed`.
- `after:YYYY-MM-DD` matches messages received on or after the start of that UTC day, and `before:YYYY-MM-DD` messages received before it. Both use the canonical first-indexed received time and accept `/` as the separator.

An invalid date SHALL return no messages.

#### Scenario: Sender and state
- **WHEN** `from:alex is:unread` is searched
- **THEN** only unread messages whose sender name or address contains alex are returned

#### Scenario: Date range
- **WHEN** `after:2026-01-01 before:2026-02-01` is searched
- **THEN** only messages first indexed with a received time in January 2026 (UTC) are returned

#### Scenario: Invalid date
- **WHEN** `before:2026-02-30` is searched
- **THEN** no messages are returned

### Requirement: Folder and account operators
The operators below SHALL narrow which sources a search reads:
- `in:<folder>` keeps sources whose mailbox path, last path segment or well-known special-use name matches. For example, `in:sent` matches `SENT`, `Sent Items` and `[Gmail]/Sent Mail`.
- `account:<value>` keeps sources whose account id, or part of whose address or name, matches.
- `in:anywhere` selects the everywhere scope.

#### Scenario: Negated folder
- **WHEN** `invoice -in:sent` is searched across Inbox and Sent
- **THEN** only Inbox messages containing invoice are returned

### Requirement: Search everywhere
`POST /api/messages/query` SHALL accept `scope: "everywhere"`, with `sources` empty or omitted, and SHALL then search every account/mailbox pair that holds indexed messages. `in:anywhere` SHALL have the same effect for any request. The everywhere scope SHALL read the local index only, without provider fallback, and SHALL report coverage for every folder it read.

#### Scenario: All mail
- **WHEN** a client queries `{ scope: "everywhere", query: "contract" }`
- **THEN** matching messages from every folder of every account are returned with one cursor and no provider is contacted

#### Scenario: Sources required otherwise
- **WHEN** a client queries with no sources and the default scope
- **THEN** the request fails with 400

### Requirement: Group the list by conversation
`POST /api/messages/query` SHALL accept `group: "conversation"`. The response SHALL then contain one representative message per conversation in the current view (sources, scope, filter and search), which is the conversation's first message in the view's sort order. A conversation SHALL appear at most once across the pages of one cursor.

#### Scenario: New reply between pages
- **WHEN** a reply arrives in a conversation already shown on the first page and the next page is loaded
- **THEN** the conversation is not repeated

### Requirement: Conversation group details
A grouped response SHALL carry a `groups` array aligned with `messages`. For the conversation's messages in the view, each group SHALL give:
- the count and unread count;
- up to ten distinct senders, newest first;
- the newest message's received time and preview;
- up to 100 member summaries, newest first.

#### Scenario: Thread in the Inbox
- **WHEN** three messages of one conversation are in the Inbox and a fourth is in Archive, and the Inbox is grouped
- **THEN** one row reports 3 messages, its unread count and its participants, and the Archive message is not counted

### Requirement: Conversation rows in the web interface
The list header SHALL offer a **Conversations** toggle that the browser remembers. A grouped row SHALL show its participants, the count when above one, the latest snippet and time, and unread state when any member is unread. An action on a selected or focused group row SHALL apply to each of its members in the view.

#### Scenario: Archive a conversation
- **WHEN** a person selects a grouped row of three messages and chooses Archive
- **THEN** all three messages are archived and messages of the conversation outside the view are untouched

### Requirement: Page latency at scale
A list, unified list, search or grouped page of 50 SHALL be served from indexed sort keys and bounded candidate sets, without sorting every message in the selected sources or reading message JSON for every candidate. Coverage SHALL read maintained per-folder counters. With 100,000 indexed summaries, pages SHOULD complete within about 50 ms on commodity hardware, as measured by `scripts/bench-mail-query.ts`.

#### Scenario: Large unified Inbox
- **WHEN** a unified Inbox of 60,000 locations across three accounts is paged
- **THEN** each page reads at most a bounded number of sort keys beyond the 51 it returns, and its coverage is read from one counter row per folder
