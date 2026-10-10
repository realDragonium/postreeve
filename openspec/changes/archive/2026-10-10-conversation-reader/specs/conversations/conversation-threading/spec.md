## ADDED Requirements

### Requirement: Conversation message summaries endpoint
The system SHALL serve `GET /api/conversations/:conversationId/messages` for a current or aliased conversation ID, returning its canonical message summaries in conversation order. Each summary SHALL use one deterministically chosen current indexed location from any account or folder of the tenant; members without one SHALL be omitted. The endpoint SHALL read only stored data and SHALL answer an unknown ID with HTTP 400 `Conversation not found`.

#### Scenario: Reply in Sent
- **WHEN** an Inbox message has a reply stored in the account's Sent folder and a client requests the message's conversation summaries
- **THEN** the response lists the Inbox message and then the Sent reply, each with its own location, subject, sender and preview

#### Scenario: Message without a location
- **WHEN** a conversation member has no remaining location
- **THEN** the response omits it and keeps the other members in conversation order

#### Scenario: Unknown conversation summaries
- **WHEN** a client requests summaries for a conversation ID that was never issued
- **THEN** the response is HTTP 400 with `error` `Conversation not found`
