## MODIFIED Requirements

### Requirement: Compose modes start from the source message
The web interface SHALL open reply, reply-all and forward forms from a message and store the mode and source with the draft. A reply SHALL address the source's Reply-To, or else its From, without the account's own addresses, its primary address and identities, and quote the source; reply-all SHALL also copy the source's other To and Cc addresses to Cc; a forward SHALL start without recipients, with a `Fwd: ` subject and the forwarded message in the body.

#### Scenario: Reply-all recipients
- **WHEN** a user replies all to a message from Alice to the user and Bob, with Carol in Cc
- **THEN** To holds Alice and Cc holds Bob and Carol, without the user's own address

#### Scenario: Conversation draft without its source
- **WHEN** a user opens a reply draft that has no source
- **THEN** sending is unavailable, **Convert to a new message** changes its mode to `new`, and sending it unconverted through the API answers 400 `Conversation draft source was not found`

### Requirement: Sending a draft is validated before dispatch
The system SHALL send a draft at `POST /api/accounts/<accountId>/drafts/<draftId>/send` with `{ version }`, answering with the send receipt. Before dispatch it SHALL refuse, leaving the draft unchanged: a stale version or a draft in `sending` or `uncertain` with 409 `draft_conflict`, and with 400 a file without stored content, an identity the account does not have, raw recipients that do not split on commas into valid addresses, an empty To or body, or an invalid source.

#### Scenario: Unparseable raw recipients
- **WHEN** a draft whose `to` is `alice@` is sent
- **THEN** the response is 400, nothing is dispatched and the stored `to` is still `alice@`

#### Scenario: Send already in progress
- **WHEN** a client sends a draft whose delivery is `sending`
- **THEN** the response is 409 `draft_conflict` and nothing is dispatched

#### Scenario: Identity that is not stored
- **WHEN** a client sends a draft whose identity address is `other@example.test` and the account has no such identity
- **THEN** the response is 400 `Draft identity does not belong to the selected account` and nothing is dispatched

## ADDED Requirements

### Requirement: Compose From follows the receiving identity
For reply, reply-all and forward forms, From SHALL default to the first of the source's Delivered-To, To and Cc addresses that is the account's address or one of its identities, or else the primary address. The compose form SHALL disable sending while its From address is neither.

#### Scenario: Reply to mail delivered to an alias
- **WHEN** a user replies to a message delivered to their identity `sales@example.test` through a catch-all
- **THEN** From is preselected as `sales@example.test` and `sales@example.test` is not a recipient

#### Scenario: Saved draft from a removed identity
- **WHEN** a user opens a draft whose identity was removed from the account
- **THEN** the From selector shows that address and Send is disabled until another identity is chosen
