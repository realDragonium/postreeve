## MODIFIED Requirements

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

### Requirement: Cursor isolation
Continuation cursors SHALL be bound to the tenant, mailbox sources, scope, query, filter, sort and grouping. Malformed or mismatched cursors SHALL be rejected before provider access.

#### Scenario: Changed query
- **WHEN** a cursor from one search is reused for another
- **THEN** the request fails instead of continuing a different result set

#### Scenario: Changed grouping
- **WHEN** a cursor from a grouped list is reused for the ungrouped list
- **THEN** the request fails instead of continuing a different result set

### Requirement: Search from the web interface
Enter SHALL submit trimmed search text for one backend query across the current view and restart cursor paging. Clearing search SHALL restore the unsearched view. The / key SHALL focus search. While a search is active, the list header SHALL offer **Everywhere**, which runs the same search across every folder of every account. An empty result outside the everywhere scope SHALL suggest searching Everywhere.

#### Scenario: Search the open folder
- **WHEN** quarterly planning is submitted
- **THEN** the count line names the query and the backend returns matching messages

#### Scenario: Widen to everywhere
- **WHEN** a person searches contract in Inbox and selects Everywhere
- **THEN** matches from Archive and from other accounts are listed in one cursor

## ADDED Requirements

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
