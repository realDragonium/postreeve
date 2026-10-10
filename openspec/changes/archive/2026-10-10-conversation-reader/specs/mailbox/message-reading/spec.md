## MODIFIED Requirements

### Requirement: Reader shows the message header
When a person opens a message, the web interface SHALL show its subject (or "(No subject)"), sender name and address, To and Cc recipients, the date, and any `deliveredTo` addresses not already among the To recipients as "delivered to …". On narrow screens the reader SHALL replace the list and offer a control back to it.

#### Scenario: Catch-all address shown
- **WHEN** a message to `alex@example.com` has `deliveredTo` `planning-alias@example.com`
- **THEN** the reader shows "delivered to planning-alias@example.com"

#### Scenario: Header for each expanded conversation message
- **WHEN** a conversation message is expanded in the reader
- **THEN** it shows that message's sender name and address, recipients, Cc, delivered-to addresses and date

## ADDED Requirements

### Requirement: Reader shows the whole conversation
When a person opens a message, the reader SHALL show every message of its conversation that has a current location (conversations/conversation-threading), in conversation order and from any folder or account, with the opened list message in place of its own entry. Until the conversation has loaded, or when it cannot be loaded, the reader SHALL show the opened message alone.

#### Scenario: Own reply from Sent
- **WHEN** a person opens an Inbox message whose conversation includes their reply in Sent
- **THEN** the reader shows the Inbox message followed by the reply

#### Scenario: Conversation unavailable
- **WHEN** the conversation request fails
- **THEN** the reader still shows the opened message with its body

### Requirement: Read conversation messages start collapsed
The reader SHALL start with the opened message and unread messages expanded and every other message collapsed to its sender, date and preview. Selecting a collapsed message SHALL expand it, and selecting an expanded message's header SHALL collapse it. The reader SHALL scroll the opened message into view.

#### Scenario: Older read message
- **WHEN** a person opens the latest message of a conversation whose earlier message is read
- **THEN** the earlier message shows only its sender, date and preview until the person selects it

### Requirement: Conversation bodies load on demand
The reader SHALL read a conversation message's body only while that message is expanded, through the same read path as the opened message, so collapsed messages request no body and no remote content. A failed read SHALL show its error inside that message only.

#### Scenario: Expanding a collapsed message
- **WHEN** a person expands a collapsed message
- **THEN** its body is read and shown, and its read state and location at the provider do not change

#### Scenario: One body fails
- **WHEN** reading one expanded message fails
- **THEN** that message shows the error and the other messages stay readable

### Requirement: Conversation messages keep reader features
Each expanded message SHALL show its own attachments, sanitized and isolated HTML or plain text, and remote-image notice with its own consent, and SHALL offer Reply, Reply all and Forward that compose from that message and its account. Mailbox actions, provenance, the position counter and keyboard shortcuts SHALL keep targeting the opened list message.

#### Scenario: Reply to an earlier message
- **WHEN** a person selects Reply on an earlier expanded message of the conversation
- **THEN** the reply is addressed from that message's sender and quotes that message

#### Scenario: Archive from a conversation
- **WHEN** a person selects Archive while reading a conversation
- **THEN** only the opened list message is archived
