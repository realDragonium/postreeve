# Spec Delta

## Purpose

Suggests recipient addresses while composing, from the people the person has corresponded with in their locally synchronized mail, without contacting a mail provider.

## ADDED Requirements

### Requirement: Correspondents are derived from indexed headers
The system SHALL derive correspondents per account from the From, To and Cc headers of messages in the local synchronized index. A message whose first From address is one of the person's account addresses or identities SHALL count as sent to each distinct To and Cc address; any other message SHALL count as received from its first From address. Addresses SHALL be compared in lower case.

#### Scenario: Sent and received mail
- **WHEN** the index holds a message from the person to `Bob <bob@example.test>` and a message from `carol@example.test` to the person
- **THEN** `bob@example.test` counts one sent message and `carol@example.test` counts one received message

### Requirement: Correspondents follow the index
Messages added to, changed in or removed from the index SHALL change the derived correspondents, and an address SHALL no longer be suggested once the index holds no message counting for it. Removing an account SHALL remove that account's contribution.

#### Scenario: Account removed
- **WHEN** `dave@example.test` occurs only in mail of an account that is then removed
- **THEN** `dave@example.test` is no longer suggested

### Requirement: Suggestions follow index retention
Suggestions SHALL use only headers the synchronized index retains. Header retention is unaffected by preview and body retention, so suggestions SHALL remain for messages whose preview and body text have expired.

#### Scenario: Preview expired
- **WHEN** the preview of the only message from `erin@example.test` expires under the retention policy
- **THEN** `erin@example.test` is still suggested

### Requirement: Recipient suggestions API
The system SHALL answer `GET /api/recipient-suggestions?q=<query>&limit=<n>` with up to `limit` suggestions `{ name, address }`, reading only local data and never calling a mail provider. `q` SHALL be 1 to 100 characters after trimming and `limit` an integer from 1 to 20, defaulting to 8; other input SHALL be answered 400.

#### Scenario: Query too long
- **WHEN** a client asks with a 101-character `q`
- **THEN** the response is 400

### Requirement: Suggestions match, merge and exclude own addresses
A suggestion SHALL match when the query occurs case-insensitively in its address or display name. Suggestions SHALL be merged across accounts by address and named with the most recent non-empty display name. Every account address and identity of the person SHALL be excluded.

#### Scenario: Substring of a name
- **WHEN** a client asks for `q=LIC` and Alice Example `<alice@example.test>` is a correspondent
- **THEN** the answer contains `{ name: "Alice Example", address: "alice@example.test" }`

#### Scenario: Own addresses excluded
- **WHEN** the person's identity `sales@example.test` appears in indexed mail and a client asks for `q=sales`
- **THEN** `sales@example.test` is not suggested

### Requirement: Suggestions are ranked by correspondence
Suggestions whose address or a word of whose display name starts with the query SHALL precede other matches. Within those groups, addresses the person sent to SHALL precede addresses that only mailed them, and then suggestions SHALL be ordered by message count weighted toward sent mail and decayed by the age of the most recent message.

#### Scenario: Sent outranks received
- **WHEN** the person sent once to `ann@example.test` and received five messages from `anna@example.test`, and a client asks for `q=ann`
- **THEN** `ann@example.test` is suggested before `anna@example.test`

### Requirement: Compose recipient fields offer suggestions
The To, Cc and Bcc fields of the compose form SHALL request suggestions for the address being typed after the last comma and show them in a list whose first suggestion is active. Arrow Down and Arrow Up SHALL move the active suggestion, Enter or Tab SHALL replace the typed address with the active suggestion's address followed by `, `, and Escape SHALL close the list. Enter SHALL NOT send the message while the list is shown.

#### Scenario: Accept with the keyboard
- **WHEN** a user types `bob@x.test, al` in To, where `albert@example.test` and `alice@example.test` are suggested in that order, and presses Arrow Down and then Enter
- **THEN** To reads `bob@x.test, alice@example.test, ` and the message is not sent

### Requirement: Recipient fields remain comma-separated text
The recipient fields SHALL remain comma-separated text: pasting a comma-separated list and the existing validation of recipient addresses SHALL be unchanged by suggestions.

#### Scenario: Pasted list
- **WHEN** a user pastes `a@example.test, b@example.test` into Cc and sends
- **THEN** both addresses are used as Cc as before
