# Message Identity Specification

## Purpose
Defines how Postreeve turns provider observations (an IMAP message in a folder, a Gmail message under a label) into one canonical message with a stable canonical ID, how Message-IDs are normalized, how locations and moves update a canonical message, and how message references are revalidated before use. Identity is scoped to the local installation, so it spans all of its accounts. Grouping canonical messages into conversations is specified in conversations/conversation-threading; listing, searching and reading in mailbox/message-listing and mailbox/message-reading; applying actions in actions/message-actions.

## Requirements

### Requirement: One canonical message per Message-ID
The system SHALL resolve every provider observation to exactly one canonical message with a stable canonical ID. Observations whose normalized Message-IDs are equal SHALL resolve to the same canonical message, whether they come from different folders, different Gmail labels or different accounts of the installation. Observing the same message again SHALL return the same canonical ID.

#### Scenario: Same message delivered to two accounts
- **WHEN** a message with Message-ID `<message@example.test>` is listed in an IMAP account and later in a Gmail account
- **THEN** both listings report the same `canonicalId`
- **AND** the canonical message has two locations

#### Scenario: Refresh keeps the canonical ID
- **WHEN** a folder is listed twice without changes in between
- **THEN** every message keeps the `canonicalId` and `conversationId` it had after the first listing

### Requirement: Message-IDs are compared by normalized content
The system SHALL accept a Message-ID only when the field holds exactly one message identifier, allowing comments, folding whitespace and the obsolete RFC 5322 forms around it and inside it. It SHALL compare identifiers by decoded content: quoted strings and quoted pairs in the left part are decoded, the left part stays case-sensitive, and the right part, including domain literals, is lowercased. Any other content in the field SHALL make the message count as having no Message-ID.

#### Scenario: Equivalent spellings resolve to one message
- **WHEN** messages are observed with Message-IDs `<"ab"@Example.Test>`, `<"a\b"@example.test>` and `<ab@example.test>`
- **THEN** all three resolve to one canonical message whose `messageId` is `<ab@example.test>`

#### Scenario: Obsolete syntax and comments
- **WHEN** a message is observed with Message-ID `(source) <foo(comment).bar@(domain)Example.(part)Test>`
- **THEN** its normalized Message-ID is `<foo.bar@example.test>`

#### Scenario: Left part case is significant
- **WHEN** one message has Message-ID `<Ab@example.test>` and another `<ab@example.test>`
- **THEN** they are different canonical messages

#### Scenario: Malformed field
- **WHEN** a message's Message-ID field holds two identifiers, phrase or trailing text, non-ASCII characters, a bare line feed, an unbalanced comment or quote, an empty dot-separated part such as `<foo..bar@example.test>`, or a quoted right part
- **THEN** the message is treated as having no Message-ID

### Requirement: Messages without a Message-ID use their provider identity
A message SHALL count as having no Message-ID when the field is absent, invalid or repeated, even with identical values, and its results then report `messageId` as an empty string. Its identity SHALL come from the provider: a Gmail message by account and Gmail message ID, the same under every label; an IMAP message by account, folder, UIDVALIDITY and UID, so copies in different folders stay distinct unless a recorded move or a later Message-ID links them.

#### Scenario: Repeated identical Message-ID header
- **WHEN** a message carries two `Message-ID: <same@example.test>` headers
- **THEN** it has no Message-ID and is identified by its provider identity

#### Scenario: Gmail message under two labels
- **WHEN** a Gmail message without a Message-ID is listed under `INBOX` and under a user label
- **THEN** both listings report the same `canonicalId`

#### Scenario: Same UID in two IMAP folders
- **WHEN** IMAP messages without a Message-ID have UID 42 in both `INBOX` and `Archive`
- **THEN** they are two different canonical messages

#### Scenario: Unchanged IMAP location
- **WHEN** an IMAP message without a Message-ID is listed again at the same folder, UIDVALIDITY and UID
- **THEN** it keeps its canonical ID

### Requirement: Known provider locations keep their identity
When an observation without a Message-ID arrives at a provider location already associated with a canonical message, the system SHALL resolve it to that canonical message and keep its Message-ID and threading metadata. When an observation at such a location carries a valid Message-ID different from the associated message's, the system SHALL resolve it to a different canonical message and keep the earlier canonical message without that location.

#### Scenario: Message-ID missing on a later observation
- **WHEN** a Gmail message first observed with Message-ID `<message@example.test>` is later observed under another label without a Message-ID
- **THEN** the later observation resolves to the same canonical message, which still reports `<message@example.test>`

#### Scenario: IMAP UID reused for another message
- **WHEN** an IMAP location first holds `<message@example.test>` and is later observed holding `<replacement@example.test>`
- **THEN** the replacement is a new canonical message and the first canonical message remains retrievable with no locations

### Requirement: A message gaining a Message-ID is promoted or merged
When a message first identified without a Message-ID is observed at the same provider identity with a valid Message-ID, the system SHALL keep its canonical ID and conversation if no canonical message has that Message-ID yet. Otherwise the system SHALL merge it into the existing canonical message, which keeps its ID and gains the merged ID as an alias, and SHALL combine their locations, threading metadata, Gmail threads and conversation membership.

#### Scenario: Promotion keeps the ID
- **WHEN** an IMAP message listed without a Message-ID is read and the read returns Message-ID `<read-103@example.test>`
- **THEN** the canonical message keeps its ID and now reports `messageId` `<read-103@example.test>`

#### Scenario: Merge into an existing message
- **WHEN** a Gmail fallback message is later observed with a Message-ID already held by an IMAP canonical message
- **THEN** the IMAP canonical ID survives, its `aliases` include the fallback ID, and it lists the locations of both

#### Scenario: Several observations of one location in one listing
- **WHEN** one listing observes the same location without a Message-ID, then with a valid Message-ID, then without again
- **THEN** all three results report the same surviving canonical ID

### Requirement: Superseded canonical IDs remain resolvable aliases
The system SHALL keep every canonical ID that was merged away as an alias of the surviving canonical message, including aliases the merged message already had, and SHALL report them in `canonicalAliases` on listing and reading results and in `aliases` on canonical messages. Resolving a canonical message by an alias SHALL return the surviving canonical message, including when an alias is given as the source of a reply or forward (compose/sending).

#### Scenario: Repeated merges
- **WHEN** two Gmail fallback messages are each merged into the same identified canonical message
- **THEN** both fallback IDs resolve to the survivor and both appear in its aliases

#### Scenario: Alias used as a reply source
- **WHEN** a reply is sent with a superseded canonical message ID and conversation ID as its source
- **THEN** the system resolves both to the surviving message and conversation

### Requirement: Locations record where a canonical message is
The system SHALL record one location per account, folder or label and provider position at which a canonical message was observed, each with its own read and flagged state and current message reference. A changed read or flagged state SHALL update the location without changing the canonical message. A complete folder listing SHALL remove that folder's locations it did not observe; partial listings, searches and reads SHALL NOT remove locations.

#### Scenario: Flag change
- **WHEN** a message is listed again after being marked read and flagged on the server
- **THEN** its location reports `read` and `flagged` as true and its canonical ID is unchanged

#### Scenario: Truncated listing
- **WHEN** a folder listing is cut off by its limit
- **THEN** locations in that folder that the listing did not include are kept

#### Scenario: Complete listing without the message
- **WHEN** a complete listing of `INBOX` no longer includes a message
- **THEN** its `INBOX` location is removed and its other locations are kept

### Requirement: Canonical messages outlive their locations
The system SHALL keep a canonical message, its aliases and its conversation membership when it has no locations left. Removing an account SHALL remove that account's locations and provider links but SHALL NOT remove canonical messages.

#### Scenario: Account removed
- **WHEN** an account is removed
- **THEN** its canonical messages remain retrievable with no locations from that account

### Requirement: Moves keep the canonical message and its conversation
When an action or its undo moves a message (actions/message-actions), the system SHALL link the old and new provider references to the same canonical message, so it keeps its canonical ID, threading metadata and conversation even without a Message-ID. A destination already observed as a separate message without a Message-ID SHALL be merged into the moved message as an alias. A message with a Message-ID SHALL keep its canonical ID when it reappears elsewhere without a recorded move.

#### Scenario: Move and undo without a Message-ID
- **WHEN** a message without a Message-ID is moved from `INBOX` to `Archive` and the move is undone
- **THEN** listing `Archive` after the move and `INBOX` after the undo both report the original `canonicalId`

#### Scenario: Location vanishes before the move is observed
- **WHEN** a message with a Message-ID disappears from a complete `INBOX` listing and later appears in `Archive`
- **THEN** it keeps its canonical ID

### Requirement: Identity failures do not undo a successful provider action
When the provider has applied an action but the system cannot link the new reference to the canonical message, the operation SHALL remain `applied` and undoable, and its `error` SHALL start with `Provider action succeeded, but local message identity could not be retained`. This SHALL happen when the source reference is unknown locally, when the move would join two canonical messages with different Message-IDs, or when the local record cannot be written.

#### Scenario: Source identity unknown
- **WHEN** a message is moved whose reference was never observed locally
- **THEN** the operation is `applied` with an error mentioning `source identity is unknown`, and undo still succeeds

#### Scenario: Conflicting Message-IDs
- **WHEN** a move's destination reference is already associated with a canonical message with a different Message-ID
- **THEN** both canonical messages stay separate and the operation carries the identity warning

### Requirement: Message references are revalidated before actions
A message reference SHALL identify one provider message by account, folder or label, UIDVALIDITY, UID and change marker (`modseq`); Gmail references add the Gmail message ID and use its history ID as change marker. Before any action the system SHALL check that the message still exists at the reference, with the same IMAP UIDVALIDITY and, when present, the same change marker. A stale reference SHALL fail only its own item, with `Message is stale, changed, or missing`.

#### Scenario: Message changed since listing
- **WHEN** an action is applied to a reference whose message changed on the server after it was listed
- **THEN** that item fails as stale and the other items in the batch are applied

#### Scenario: IMAP folder rebuilt
- **WHEN** an IMAP folder's UIDVALIDITY changed after a message was listed
- **THEN** acting on or reading the old reference fails

### Requirement: Results carry canonical identity
Every message summary and detail returned by listing, searching and reading SHALL carry `canonicalId`, `canonicalAliases` and `conversationId`. A listing or search that observes one canonical message more than once SHALL return it once, using the first occurrence and the combined aliases. A read SHALL return one detail per requested reference, in request order, even when several references resolve to the same canonical message.

#### Scenario: Duplicate delivery in one folder
- **WHEN** a folder holds two copies of the same message
- **THEN** the listing returns one summary for it and the canonical message keeps both locations

#### Scenario: Reading the same message twice
- **WHEN** a read requests an `Archive` reference, an `INBOX` reference and the `Archive` reference again, all of the same message
- **THEN** three details are returned in that order with one `canonicalId`

### Requirement: Canonical received time is the earliest valid provider time
The system SHALL set a canonical message's `receivedAt` to the earliest valid timestamp among all its observations, and SHALL leave it null when no observation has one. IMAP observations SHALL use the internal date, then the envelope date, then the Date header; Gmail observations SHALL use the internal date, then the Date header.

#### Scenario: Later observation is earlier
- **WHEN** a message observed with time `2026-09-03T12:00:00Z` is observed in another account with `2026-09-02T12:00:00Z`
- **THEN** the canonical `receivedAt` is `2026-09-02T12:00:00.000Z`

#### Scenario: No usable date
- **WHEN** no observation of a message has a valid date
- **THEN** the canonical `receivedAt` is null

### Requirement: Observations are recorded atomically
The system SHALL record the observations from one listing, search or read of a folder as a single all-or-nothing change. It SHALL reject a batch containing an observation with an empty provider message ID or one outside the folder and account being recorded, and record none of it.

#### Scenario: Later observation fails
- **WHEN** a batch of observations fails on its last observation
- **THEN** no canonical message, location or alias from that batch is stored

### Requirement: Store upgrades preserve message identity
When opening a store written by an earlier version, the system SHALL keep every existing canonical ID and SHALL merge stored messages whose Message-IDs are equal under the current normalization into the one already stored in normalized form, or else the earliest-created one. It SHALL still match messages stored under an older provider-identity format when that identity belongs unambiguously to one account and location. An upgrade SHALL complete or leave the store unchanged.

#### Scenario: Equivalent stored Message-IDs
- **WHEN** a store holds canonical messages `plain`, `quoted` and `escaped` with Message-IDs `<ab@example.test>`, `<"ab"@example.test>` and `<"a\b"@example.test>`
- **THEN** after the upgrade `quoted`, `escaped` and their old aliases all resolve to `plain`, which holds all three locations

#### Scenario: Ambiguous older identity
- **WHEN** an older provider identity could belong to two accounts whose IDs contain delimiter characters
- **THEN** a new observation does not claim it, a new canonical message is created, and the older message remains retrievable

#### Scenario: Failed upgrade
- **WHEN** an upgrade step fails on malformed stored data
- **THEN** opening the store fails and its previous contents and schema are unchanged

#### Scenario: Reopening an upgraded store
- **WHEN** an upgraded store is opened again
- **THEN** no canonical message, alias or conversation changes
