# Design

## Context
`GET /api/conversations/:id` returns ordered canonical messages with headers only: no subject, sender, preview or location, so the web interface cannot show or read them. Summaries and current locations already live in the synchronization index (`indexed_messages` joined with `message_locations`), which also backs list pages. The reader (`Reader.tsx`) renders one `CanonicalMessageDetail` that `App.tsx` reads for the opened list row.

## Goals / Non-Goals
**Goals:** show the opened message's conversation using stored data plus on-demand body reads; keep every existing per-message reader guarantee.

**Non-Goals:** grouping the message list by conversation, conversation-level actions (archive the whole thread), a WebMCP conversation tool, provider calls to discover thread members that were never synchronized.

## Decisions
- **New summaries endpoint instead of enriching `GET /api/conversations/:id`.** The existing contract is specified as content-free canonical messages; adding summaries there changes its shape for every caller. `GET /api/conversations/:id/messages` returns `CanonicalMessageSummary[]`, the schema the list already uses, so the reader handles thread members exactly like list rows. Alternative considered: the web client calling `/conversations/:id` and then searching the index per member; rejected because it needs one request per member and no endpoint maps a canonical ID to a location.
- **One indexed query, ordered by the stored conversation.** The service takes the ordered canonical IDs from `getConversation` and asks the synchronization store for one representative location per ID in one query, using the same representative ordering as list queries (account, mailbox, newest UID). Members without a location or index row are dropped. Query count stays fixed regardless of conversation size.
- **Opened row replaces its own entry.** The reader substitutes the opened list summary for its canonical entry, so actions, stale-reference handling and the existing representative refresh keep using the list's location. If the opened message is missing from the response, or the request is pending or failed, the thread is just the opened message.
- **Expansion state is local to the reader.** Initially expanded: the opened message plus unread members. A pure helper computes the thread and initial expansion and is unit-tested. Each expanded message owns its own `readMessages` query keyed by its reference, so bodies load on demand and collapsing keeps the cached body. The reader is re-keyed by the opened message, so consent and expansion reset per open.
- **Per-message component.** `Reader` keeps the toolbar, subject heading, provenance and hint bar; a `ConversationMessage` component renders one header, attachments, `EmailBody` and reply buttons. `EmailBody` already isolates consent per instance.
- **List grouping: recommend, not implement.** Grouping changes cursor pagination (pages of conversations rather than canonical messages), filter semantics (a thread is unread when any member is), sort keys and bulk actions. That is a backend query change with its own spec, not a small UI tweak. Follow-up proposal: `group-list-by-conversation`, adding a `group: "conversation"` query option that pages conversations by their newest matching member and shows member count and unread state.

## Risks / Trade-offs
- [Unsynchronized members are invisible] → the conversation comes from the local index; synchronized Sent folders cover the common case. Documented in the spec as members with a current location.
- [Several unread members trigger several body reads] → reads are per-message and only for expanded messages; each read is bounded to one reference.
- [Representative location differs from the folder the person expects] → any current location reads the same message; the opened message always uses its list location.

## Migration Plan
No store migration. Ship UI and endpoint together; rollback is reverting the change.
