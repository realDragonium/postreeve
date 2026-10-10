## REMOVED Requirements

### Requirement: Mail is sent only from the account's primary address
**Reason**: Drafts may now be sent from the account's stored identities (compose/identities).
**Migration**: Add the address as an identity of the account; drafts saved with it then send from it. `POST /api/messages/send` keeps sending from the primary address.

## ADDED Requirements

### Requirement: Mail is sent from the selected identity
A sent draft SHALL use its identity as From, with the stored identity name when the draft's name is empty. `POST /api/messages/send` has no From field and SHALL use the account's display name and primary address. SMTP SHALL use the From address as envelope sender; a server refusing it fails before dispatch. The resolved From SHALL be the sender address for every header derived from it.

#### Scenario: Reply from an alias over SMTP
- **WHEN** an IMAP account sends a reply draft whose identity is its stored identity `sales@example.test`
- **THEN** the message has `From: Sales <sales@example.test>` and the SMTP `MAIL FROM` is `sales@example.test`

#### Scenario: Direct send
- **WHEN** a client sends through `POST /api/messages/send`
- **THEN** the message is sent from the account's display name and primary address

### Requirement: Gmail sends only from verified Send-as addresses
Before sending a Gmail message whose From address is not the account's address, the system SHALL read the account's Send-as addresses through the Gmail API and SHALL refuse before dispatch, unless the address is listed and not pending verification, with `Gmail does not allow sending as <address>; add and verify it under Gmail Settings > Accounts > Send mail as`. A failure to read the list SHALL also fail before dispatch.

#### Scenario: Verified alias
- **WHEN** a Gmail draft is sent from `alias@example.test` and Gmail lists it as an accepted Send-as address
- **THEN** the message is submitted with `From: <alias@example.test>` as chosen

#### Scenario: Address not configured in Gmail
- **WHEN** a Gmail draft is sent from a stored identity Gmail does not list as Send-as
- **THEN** nothing is submitted and the draft is recorded as `failed` with the Send mail as message
