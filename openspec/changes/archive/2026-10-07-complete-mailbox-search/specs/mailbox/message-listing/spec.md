## MODIFIED Requirements

### Requirement: List the newest messages in a folder
The system SHALL serve indexed cursor pages of 1–100 canonical summaries (default 50) for selected account/mailbox sources at POST /api/messages/query. The existing account GET endpoint SHALL retain bounded provider listing for compatibility. Invalid queries or scope-bound cursors SHALL fail with 400.

#### Scenario: Default page size
- **WHEN** a client queries 300 synchronized messages without a limit
- **THEN** the first 50 summaries and a continuation cursor are returned

#### Scenario: Limit above the maximum
- **WHEN** limit 101 is requested
- **THEN** the request fails with 400 before provider access

### Requirement: Search within a folder
Search SHALL match literal case-insensitive text in SQLite-indexed sender, recipients, subject, headers, preview and bounded body text within selected mailbox sources. Search SHALL NOT interpret Gmail query syntax. Provider search SHALL supplement incomplete indexed coverage, with its limitations reported.

#### Scenario: Literal search
- **WHEN** a person searches for invoice
- **THEN** only indexed fields containing invoice or reported provider fallback matches are returned

#### Scenario: IMAP search
- **WHEN** invoice is searched in the IMAP Inbox
- **THEN** indexed sender, recipients, subject, headers and retained preview/body fields are matched literally inside Inbox

#### Scenario: Gmail search in Archive
- **WHEN** from:alex is searched in a synchronized Gmail Archive
- **THEN** the indexed query matches the literal text from:alex within the selected Archive locations, without interpreting Gmail operators

#### Scenario: Overlong query
- **WHEN** a 201-character query is supplied
- **THEN** the request fails with 400

### Requirement: Unified view lists across accounts
The unified view SHALL send its matching account/mailbox sources to one backend query. The backend SHALL filter, sort, deduplicate canonical identities and paginate the combined results. Rows SHALL retain their representative account colour.

#### Scenario: Unified Inbox
- **WHEN** a person opens Unified Inbox across Gmail and IMAP
- **THEN** one cursor pages the combined canonical results

### Requirement: Filter the visible list
All, Unread and Flagged filters SHALL apply before pagination to every indexed message in the selected sources. Mutable flags SHALL come from a representative matching location.

#### Scenario: Unread filter
- **WHEN** Unread is selected in a synchronized folder
- **THEN** unread messages beyond the initial 100 messages remain reachable

### Requirement: Sort the visible list
Newest and Oldest SHALL order the complete indexed selection by received timestamp, Sender by first sender name or address, and Subject by subject. Every order SHALL use canonical identity as a deterministic tie-break.

#### Scenario: Oldest first
- **WHEN** Oldest is selected
- **THEN** the earliest indexed messages are returned first across cursor pages

### Requirement: Load more messages with cursors
The UI SHALL load 50 messages initially and follow nextCursor with Load 50 more until no cursor remains. Changing source, search, filter or sort SHALL restart paging. Newly synchronized messages SHALL NOT shift the keyset position. Results are not a frozen snapshot.

#### Scenario: Third page
- **WHEN** a person loads twice more in a synchronized folder of 300 messages
- **THEN** 150 distinct messages are visible and another continuation remains

#### Scenario: Second page
- **WHEN** Load 50 more is selected in a synchronized 300-message mailbox
- **THEN** 100 messages are visible and the cursor allows further pages

### Requirement: Search from the web interface
Enter SHALL submit trimmed search text for one backend query across the current view and restart cursor paging. Clearing search SHALL restore the unsearched view. The / key SHALL focus search.

#### Scenario: Search the open folder
- **WHEN** quarterly planning is submitted
- **THEN** the count line names the query and the backend returns matching messages

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

## ADDED Requirements

### Requirement: Bounded searchable content during synchronization
Synchronization SHALL index bounded body text without requiring messages to be opened. Retained preview and body text SHALL obey the account retention policy. Missing or expired content SHALL be reported separately from metadata synchronization coverage; bounds SHALL be disclosed.

#### Scenario: Unopened message
- **WHEN** a message with available bounded body text synchronizes
- **THEN** its retained body text is searchable without opening it

#### Scenario: Retention eviction
- **WHEN** retained text expires or exceeds the account budget
- **THEN** preview/body search no longer finds evicted text, metadata remains searchable and content coverage reports the omission

### Requirement: Cursor isolation
Continuation cursors SHALL be bound to tenant, mailbox sources, query, filter and sort. Malformed or mismatched cursors SHALL be rejected before provider access.

#### Scenario: Changed query
- **WHEN** a cursor from one search is reused for another
- **THEN** the request fails instead of continuing a different result set

## RENAMED Requirements

- FROM: `### Requirement: Load more messages up to 100`
- TO: `### Requirement: Load more messages with cursors`
