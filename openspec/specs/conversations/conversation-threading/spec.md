# Conversation Threading Specification

## Purpose
Defines how Postreeve groups canonical messages into stable conversations from In-Reply-To and References headers, Gmail thread IDs and replies it sends; which conversation ID survives when conversations merge; how messages are ordered within a conversation; and the `GET /api/conversations/:conversationId` contract. Canonical messages and their identity are specified in conversations/message-identity; message content comes from mailbox/message-reading; sending replies is specified in compose/sending.

## Requirements

### Requirement: Every canonical message belongs to one conversation
The system SHALL place every canonical message in exactly one conversation with a stable conversation ID, and SHALL report it as `conversationId` on message summaries, message details and canonical messages. A message with no links to other messages SHALL form a conversation of its own.

#### Scenario: Unrelated message
- **WHEN** a message without In-Reply-To, References or Gmail thread is listed
- **THEN** its `conversationId` names a conversation that contains only that message

### Requirement: Message-ID links join conversations
The system SHALL place two canonical messages in the same conversation when the Message-ID of one appears in the other's In-Reply-To or References, or when both name the same Message-ID, even if that message was never observed. Every In-Reply-To parent SHALL count, whether several appear in one field, in repeated fields or in different observations of the message. Links SHALL be transitive.

#### Scenario: Late parent
- **WHEN** a reply with In-Reply-To `<parent@example.test>` is listed before the parent message
- **THEN** the parent joins the reply's conversation when it is listed

#### Scenario: Siblings of an unseen parent
- **WHEN** two messages both have In-Reply-To `<missing-parent@example.test>` and that message has never been observed
- **THEN** both messages are in one conversation

#### Scenario: Conflicting parents across observations
- **WHEN** one message is observed once with In-Reply-To `<parent-b@example.test>` and once with `<parent-a@example.test>`
- **THEN** both parents join its conversation when they are observed

### Requirement: Threading headers are read as identifier lists
The system SHALL read In-Reply-To and References as lists of message identifiers normalized as in conversations/message-identity, allowing obsolete phrase words between identifiers and ignoring identifiers inside quoted strings and comments. A field occurrence containing anything else SHALL contribute no identifiers. Each occurrence of a repeated field SHALL contribute its identifiers, and duplicates SHALL be dropped, keeping the first occurrence.

#### Scenario: Repeated and partly malformed In-Reply-To
- **WHEN** a message has In-Reply-To fields `Old note <parent-a@example.test>`, `broken, <discarded-parent@example.test>`, an empty field and `"quoted <fake-parent@example.test>" <parent-b@example.test>`
- **THEN** its parents are `<parent-a@example.test>` and `<parent-b@example.test>`

#### Scenario: Malformed References
- **WHEN** a References field reads `<one@example.test> garbage, <two@example.test>`
- **THEN** that field contributes no identifiers

### Requirement: Threading metadata accumulates across observations
The system SHALL combine threading metadata from every observation of a canonical message. `inReplyTo` SHALL list every parent ever observed, sorted and space-separated. `references` SHALL hold every identifier from every observed References field in the lexicographically smallest order that keeps each field's own order; identifiers whose observed orders conflict SHALL be sorted among themselves and stay before identifiers that follow them. Arrival order SHALL NOT change the result.

#### Scenario: Parents from two observations
- **WHEN** a message is observed with In-Reply-To `<parent-b@example.test>` and later with `<parent-a@example.test>`
- **THEN** its `inReplyTo` is `<parent-a@example.test> <parent-b@example.test>`

#### Scenario: Partial References observations
- **WHEN** a message is observed with References `<b@example.test>`, `<c@example.test>` and `<c@example.test> <a@example.test> <b@example.test>`, in any arrival order
- **THEN** its `references` is `<c@example.test>`, `<a@example.test>`, `<b@example.test>`

#### Scenario: Conflicting References order
- **WHEN** a message is observed with References `<y@example.test> <z@example.test> <a@example.test>` and with `<z@example.test> <y@example.test>`
- **THEN** its `references` is `<y@example.test>`, `<z@example.test>`, `<a@example.test>`

### Requirement: Gmail threads group messages within an account
The system SHALL place messages that Gmail reports in the same thread of the same account in one conversation, even without Message-ID links. Gmail thread IDs SHALL NOT link messages of different accounts, and Message-ID links SHALL still join messages from different Gmail threads or accounts. When a canonical message belongs to several Gmail threads of one account, a reply from it SHALL name one of those threads (compose/sending).

#### Scenario: Same thread ID in two accounts
- **WHEN** Gmail messages in two accounts report the same thread ID and share no Message-ID links
- **THEN** they are in different conversations

#### Scenario: Ambiguous thread for a reply
- **WHEN** a reply's source message belongs to two Gmail threads of the account and the reply names neither
- **THEN** the reply is refused and asks for a specific source location

### Requirement: Conversations merge but never split
The system SHALL keep messages that once shared a conversation together. Later observations without threading headers, moves, removed locations and removed accounts SHALL NOT split a conversation, and links learned from earlier observations SHALL be kept.

#### Scenario: Account removed
- **WHEN** an account whose message joined two conversations is removed
- **THEN** the merged conversation still contains all of its messages

### Requirement: The surviving conversation ID is deterministic
When conversations merge, the system SHALL keep the ID of a conversation that existed before the triggering change over one created by it or belonging to a message that just gained its Message-ID. Among those it SHALL keep the conversation containing the lexicographically smallest normalized Message-ID, ranking conversations without any Message-ID last, then the oldest, then the smallest ID. When two canonical messages merge, the surviving message's conversation SHALL keep its ID.

#### Scenario: Late parent keeps the reply's conversation ID
- **WHEN** a parent message is first observed after its reply
- **THEN** the conversation keeps the reply's original `conversationId`

#### Scenario: Two existing conversations linked
- **WHEN** existing conversations containing `<first@example.test>` and `<second@example.test>` are linked because `<second@example.test>` is observed again with In-Reply-To `<first@example.test>`
- **THEN** the conversation containing `<first@example.test>` keeps its ID and the other ID becomes its alias

### Requirement: Merged conversation IDs remain aliases
The system SHALL keep every conversation ID that was merged away, including aliases it already had, as an alias of the surviving conversation. Looking up a conversation by an alias SHALL return the surviving conversation, whose `aliases` list the merged IDs in the order they were merged. A reply or forward source SHALL accept an aliased conversation ID (compose/sending).

#### Scenario: Lookup by a merged ID
- **WHEN** a client requests a conversation by an ID that was merged into another
- **THEN** the response has the surviving `id` and its `aliases` include the requested ID

### Requirement: Sent replies join the source conversation
When a reply or reply-all sent through Postreeve is accepted for delivery (compose/sending), the system SHALL record the sent message as a canonical message with its Message-ID in the source's conversation, even when the source has no Message-ID, and keep it there when it is later observed and after restart. For Gmail it SHALL record the thread Gmail returns. A forward SHALL start its own conversation. If recording fails, the send SHALL still be accepted, with a warning.

#### Scenario: Reply to a message without a Message-ID
- **WHEN** a reply to a message without a Message-ID is sent and later listed in `Sent`
- **THEN** the listed reply has the recorded canonical ID and the source's `conversationId`

#### Scenario: Recording fails
- **WHEN** the provider accepts a reply but the local conversation cannot be updated
- **THEN** the receipt reports acceptance with a warning that the local conversation could not be updated

### Requirement: Conversation order follows header ancestry
The system SHALL order a conversation's messages so that each message comes after all of its In-Reply-To parents and after every message named in its References, and identifiers within each observed References field keep their relative order, also through Message-IDs that were never observed. Self-references SHALL be ignored. The order SHALL NOT depend on the order in which messages were observed.

#### Scenario: Multi-parent reply
- **WHEN** a reply has In-Reply-To `<later@example.test> <earlier@example.test>` and both parents are in the conversation
- **THEN** both parents come before the reply

#### Scenario: Ancestry through unknown identifiers
- **WHEN** a child has References `<root@example.test> <missing-a@example.test> <parent@example.test> <missing-b@example.test>` and only root and parent are stored
- **THEN** the order is root, parent, child, regardless of their dates or input order

### Requirement: Unconstrained messages are ordered by received time
Among messages whose ancestors are all placed, the system SHALL place the earliest `receivedAt` first, messages without `receivedAt` after all dated ones, and remaining ties in a stable identity order. Messages whose header links form a cycle SHALL be placed together, ordered by the same rule, before all of their descendants.

#### Scenario: Causal before chronological
- **WHEN** a conversation has an earlier root (September 2), a later root (September 3), a reply to the later root received September 1 and an undated message
- **THEN** the order is earlier root, later root, reply, undated message

#### Scenario: Reference cycle
- **WHEN** `<cycle-a@example.test>` (September 3) and `<cycle-b@example.test>` (September 2) reference each other and a child references `<cycle-a@example.test>`
- **THEN** the order is cycle-b, cycle-a, child

### Requirement: Conversation retrieval endpoint
The system SHALL serve `GET /api/conversations/:conversationId` for a current or aliased conversation ID, returning the current `id`, `aliases`, `tenantId`, `createdAt`, `updatedAt` and the ordered `messages`. Each message SHALL be a canonical message with `id`, `aliases`, `conversationId`, `tenantId`, normalized `messageId` or null, `inReplyTo`, `references` and `receivedAt`, including messages with no current location. An unknown ID SHALL return HTTP 400 with `error` `Conversation not found`.

#### Scenario: Conversation returned without content
- **WHEN** a client requests an existing conversation
- **THEN** the response lists its canonical messages in conversation order without subjects, addresses or bodies

#### Scenario: Unknown conversation
- **WHEN** a client requests a conversation ID that was never issued
- **THEN** the response is HTTP 400 with `error` `Conversation not found`

### Requirement: Conversation repair is incremental and bounded
When an observation, move or send links messages, the system SHALL update only the conversations connected to the affected messages and SHALL leave unrelated conversations unchanged; a move that links nothing new SHALL change no conversation. It SHALL handle a References field of 100,000 identifiers, comments nested 100,000 levels deep and a linked group spanning more than 1,000 Gmail threads, and SHALL read a conversation with a fixed number of store queries regardless of its size.

#### Scenario: Unrelated conversation untouched
- **WHEN** a late parent joins a reply's conversation
- **THEN** an unrelated conversation keeps its ID, members and timestamps

#### Scenario: Very long References field
- **WHEN** a message with 100,000 References identifiers is observed and the last one arrives later
- **THEN** the late message joins the conversation and the stored `references` keep all 100,000 identifiers in order

### Requirement: Store upgrades build and preserve conversations
When opening a store created before conversations existed, the system SHALL build a conversation for every stored message from its stored headers, keeping message IDs. References stored without their order SHALL act as unordered parent links until the message is observed again. On every start the system SHALL repair messages lacking a conversation or header links, without rebuilding a healthy store. An upgrade SHALL complete or leave the store unchanged.

#### Scenario: Pre-conversation store
- **WHEN** a store holding a parent and a reply but no conversations is opened
- **THEN** both messages share one conversation, ordered parent then reply, and reopening keeps that conversation

#### Scenario: Legacy References order
- **WHEN** a migrated message's stored References were saved without order and the referenced messages have different dates
- **THEN** the referenced messages are ordered by date until the message is observed again with a References field

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

### Requirement: Conversation summaries prefer the requested account
When `GET /api/conversations/:conversationId/messages` has an `accountId` query parameter, a member indexed in that account SHALL be represented by a location in that account.

#### Scenario: Message delivered to two accounts
- **WHEN** a message is indexed in the Inbox of two accounts and the conversation is requested with the second account's ID
- **THEN** its summary's reference names the second account
