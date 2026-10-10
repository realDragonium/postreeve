# Proposal

## Why
The reader shows only the selected message, although the backend already groups messages into conversations. Following a thread means hunting for each message in the list and in Sent, which is the biggest daily friction when Postreeve replaces a desktop mail client.

## What Changes
- New `GET /api/conversations/:conversationId/messages` returns the conversation's canonical message summaries in conversation order, each with one current location, including messages in other folders and accounts of the tenant. It reads only the local index; no provider is contacted.
- The reader shows the opened message's whole conversation. The opened message and unread messages start expanded; other messages are collapsed to sender, date and preview and expand on click, loading their body on demand.
- Every expanded message keeps the existing reader features: sanitized isolated HTML, per-message remote-image consent, attachments, and Reply, Reply all and Forward targeting that message.
- Toolbar actions, provenance, the position counter and keyboard navigation keep targeting the opened list message.
- Grouping the message list by conversation is not part of this change; design.md records it as a follow-up proposal.

## Capabilities

### New Capabilities

### Modified Capabilities
- `conversations/conversation-threading`: adds the conversation message summaries endpoint.
- `mailbox/message-reading`: the reader shows the conversation, with collapsed messages loaded on demand and per-message replies.

`agents/webmcp-tools` does not change: `read_messages` already reads any listed reference. A conversation tool for agents is a possible follow-up (FEATURES.md lists it as Not covered).

## Impact
Shared contracts (no new schema; the endpoint returns existing canonical summaries), the synchronization index store, core service and API route, the web API client, `Reader.tsx` and `App.tsx`, browser tests, FEATURES.md. No store migration, provider change, or change to mailbox state on reading.
