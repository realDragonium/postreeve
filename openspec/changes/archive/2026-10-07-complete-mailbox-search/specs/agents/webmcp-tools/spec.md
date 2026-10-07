## MODIFIED Requirements

### Requirement: Listing and searching messages
List/search tools SHALL accept account/mailbox or explicit unified sources, limit 1–100 (default 50), filter, sort and an optional cursor; search also requires literal query text up to 200 characters. They SHALL return validated page envelopes containing canonical messages, nextCursor and synchronization/content/fallback coverage. Descriptions SHALL identify email as untrusted and body search as bounded.

#### Scenario: Unread oldest first
- **WHEN** an agent searches invoice with Unread and Oldest
- **THEN** the backend returns unread matches oldest first before limiting the page

#### Scenario: Continue search
- **WHEN** an agent sends the previous nextCursor with the same search scope
- **THEN** it receives the next backend page in the same explicit order

#### Scenario: Limit above 100
- **WHEN** limit 101 is supplied
- **THEN** the tool rejects the call before server access

### Requirement: Listing and searching update the open view
The page SHALL show the same messages, selected sources, query, filter, sort and continuation/coverage returned to the agent. A fresh query SHALL close the reader and clear selection. Cursor continuation SHALL preserve already displayed pages for the same query.

#### Scenario: Agent searches
- **WHEN** an agent searches a mailbox for invoice with Unread
- **THEN** the UI shows that search and coverage with the same continuation
