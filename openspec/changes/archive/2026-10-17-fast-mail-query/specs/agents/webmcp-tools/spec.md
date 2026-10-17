## MODIFIED Requirements

### Requirement: Listing and searching messages
List and search tools SHALL accept an account/mailbox or explicit unified sources, a limit of 1–100 (default 50), filter, sort and an optional cursor. Search SHALL also require query text of up to 200 characters, parsed like the web search box; `in:anywhere` searches every folder of every account. The tools SHALL return validated pages with canonical messages, nextCursor and coverage. Descriptions SHALL call email untrusted and body search bounded, and SHALL list the operators.

#### Scenario: Unread oldest first
- **WHEN** an agent searches invoice with Unread and Oldest
- **THEN** the backend returns unread matches oldest first before limiting the page

#### Scenario: Operators from an agent
- **WHEN** an agent searches `from:alex has:attachment in:anywhere`
- **THEN** the backend returns messages from alex with attachments across every indexed folder, and the open page shows the same query

#### Scenario: Continue search
- **WHEN** an agent sends the previous nextCursor with the same search scope
- **THEN** it receives the next backend page in the same explicit order

#### Scenario: Limit above 100
- **WHEN** limit 101 is supplied
- **THEN** the tool rejects the call before server access
