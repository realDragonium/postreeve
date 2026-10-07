# Proposal
## Why
DRA-487 replaces the first-100 live mailbox limit with complete indexed navigation and backend unified search.
## What Changes
- Cursor pages with explicit sort and filter over synchronized canonical messages.
- SQLite search across exact sender, recipient, subject, header, preview and bounded body fields; bounded body ingestion during synchronization.
- Backend account and unified queries, provider fallback and explicit synchronization/content coverage.
- **BREAKING** WebMCP list/search return page envelopes with continuation and coverage; UI follows the same cursor path.
## Capabilities
### New Capabilities
### Modified Capabilities
- `mailbox/message-listing`: Indexed paging/search, whole-scope filtering and sorting, coverage/fallback.
- `agents/webmcp-tools`: Cursor page envelopes and unified scope.
## Impact
Shared contracts, provider synchronization observations, SQLite index and retention, core/API, React mailbox and WebMCP. No frozen snapshots, Gmail query-language promise, authentication changes or new attention workflow.
