# compose/identities Specification

## Purpose
Lets a person keep the addresses they send as, such as aliases and catch-all addresses, per account on the server, so every browser and the send path see the same identities.

## Requirements

### Requirement: Identities are stored per account
The system SHALL list an account's identities at `GET /api/accounts/<accountId>/identities` as `{ id, accountId, name, address, createdAt }` ordered by creation, and add one at `POST` with `{ name, address }`, answering 201. `name` SHALL be 1 to 120 characters after trimming and `address` a valid email address or a wildcard identity address, stored in lower case. An account SHALL hold at most 100 identities. Invalid input SHALL be answered 400.

#### Scenario: Add an alias
- **WHEN** a client posts `{ name: "Sales", address: "Sales@Example.test" }` to an account
- **THEN** the response is 201 and the account's identity list contains `sales@example.test` named `Sales`

#### Scenario: Add a wildcard
- **WHEN** a client posts `{ name: "Example", address: "*@Example.com" }` to an IMAP account
- **THEN** the response is 201 and the identity list contains `*@example.com`

#### Scenario: Unknown account
- **WHEN** a client lists identities for an account that does not exist
- **THEN** the response is 400 and nothing is stored

### Requirement: Adding an identity is idempotent per address
Adding an address the account already has as an identity, compared case-insensitively, SHALL return the stored identity unchanged with 200. Adding the account's primary address SHALL be refused with 400 `The primary address is already an identity`.

#### Scenario: Same address added twice
- **WHEN** a client adds `alias@example.test` named `A` and then `ALIAS@example.test` named `B`
- **THEN** the second response is 200 with the identity named `A`, and the account has one identity

#### Scenario: Primary address
- **WHEN** a client adds the account's own email address
- **THEN** the response is 400 and no identity is stored

### Requirement: Removing identities
The system SHALL remove an identity at `DELETE /api/accounts/<accountId>/identities/<identityId>`, answering `{ ok: true }` also when it no longer exists, together with its signature. Removing an account SHALL remove its identities and signatures. Drafts keep the identity they were saved with.

#### Scenario: Remove an alias
- **WHEN** a client removes an account's identity
- **THEN** it no longer appears in the identity list, its signature is no longer listed, and a draft saved with it can no longer be sent

#### Scenario: Account removed
- **WHEN** an account with identities is removed
- **THEN** its identities and signatures are deleted with it

### Requirement: Identities are managed in the web interface
The identity sheet SHALL list the account's primary address and its server identities and SHALL add and remove identities through the API, showing any error; its address field SHALL accept a wildcard `*@domain` for IMAP accounts. For Gmail accounts the sheet SHALL state that only addresses verified under Gmail's Send mail as setting can send.

#### Scenario: Identity visible in another browser
- **WHEN** a user adds an identity in one browser and opens compose for that account in another
- **THEN** the From selector offers the identity

### Requirement: Browser-local identities migrate once
Once accounts have loaded, the web interface SHALL add each identity from browser storage key `postreeve.local-identities.v1` to its account on the server. Malformed records, records naming the account's primary address and records answered 400 SHALL be dropped; records whose account is not loaded or whose request fails otherwise SHALL be kept and retried. `postreeve.local-identities.migrated.v1` SHALL be marked complete once nothing remains.

#### Scenario: Migration repeated
- **WHEN** an identity was migrated and the browser repeats the migration before it was marked complete
- **THEN** the server keeps one identity for that address

#### Scenario: Server unavailable
- **WHEN** the server answers 500 for a local identity
- **THEN** it stays in browser storage and the migration is not marked complete

### Requirement: Signatures are stored per sending address
The system SHALL list signatures at `GET /api/accounts/<accountId>/signatures` as `[{ address, html }]` and store one with `PUT` and `{ address, html }`, answering with it. `address` SHALL be the primary address or the address of an identity, including a wildcard `*@domain`, case-insensitive and stored in lower case, otherwise 400 `Signatures can only be set for the account's own addresses`. `html` SHALL be at most 100,000 characters; a blank `html` SHALL remove the signature.

#### Scenario: Signature for an alias
- **WHEN** a client puts `{ address: "Sales@Example.test", html: "<b>Sales team</b>" }` for an account with that identity
- **THEN** the signature list contains `sales@example.test` with that HTML

#### Scenario: Foreign address
- **WHEN** a client puts a signature for an address that is neither the primary address nor an identity
- **THEN** the response is 400 and nothing is stored

### Requirement: Signatures are managed in the identity sheet
The identity sheet SHALL offer a rich-text signature editor for the primary address and each identity, save it through the API and show any error.

#### Scenario: Edit the primary signature
- **WHEN** a user writes a signature for the primary address in the identity sheet and saves it
- **THEN** a new message from that address in any browser starts with the signature

### Requirement: Wildcard identities cover their domain
A wildcard identity address is `*@<domain>` with a dotted hostname. An address SHALL belong to an account when it is the primary address, an identity's address, or an address on the domain of one of its wildcard identities, case-insensitively; subdomains SHALL NOT be covered. A covered address SHALL be sendable as a draft identity; any other address SHALL be refused as today. Gmail accounts SHALL refuse wildcard identities. Recipient suggestions SHALL skip covered addresses.

#### Scenario: Send from a covered address
- **WHEN** an IMAP account with identity `*@example.com` sends a draft whose identity is `orders@example.com`
- **THEN** the message is sent from `orders@example.com`

#### Scenario: Undeclared domain
- **WHEN** the same account sends a draft whose identity is `orders@other.test`
- **THEN** the response is 400 `Draft identity does not belong to the selected account` and nothing is dispatched

#### Scenario: Gmail refuses a wildcard
- **WHEN** a client adds `*@example.com` to a Gmail account
- **THEN** the response is 400 `Gmail sends only from verified addresses, so wildcard identities are IMAP-only`

#### Scenario: Subdomain is not covered
- **WHEN** the same account sends a draft whose identity is `a@mail.example.com`
- **THEN** the response is 400 and nothing is dispatched

### Requirement: Compose From selector options
The compose From selector SHALL offer the primary address and the account's non-wildcard identities, plus the source and current From addresses a wildcard covers, plus a saved draft's identity when it is none of these.

#### Scenario: Covered address offered
- **WHEN** a user with identity `*@example.com` replies to mail delivered to `shop@example.com`
- **THEN** the From selector offers `shop@example.com` and not `*@example.com`

### Requirement: Wildcard signatures apply to covered addresses
Compose SHALL use the signature of the exact From address, or else the signature of the wildcard identity covering it.

#### Scenario: Wildcard signature
- **WHEN** an account has identity `*@example.com` with a signature and a user replies from `shop@example.com`
- **THEN** the reply starts with the wildcard's signature

### Requirement: Add a delivered address from compose
When a reply, reply-all or forward form's source lists a Delivered-To address that does not belong to the account, compose SHALL show that address with **Add as identity**. Adding it SHALL create the identity named after the account through the API, offer it in the From selector and select it as From.

#### Scenario: Catch-all address added while replying
- **WHEN** a user replies to mail delivered to `promo@example.com`, which is not an identity, and chooses Add as identity
- **THEN** `promo@example.com` becomes an identity and is selected as From

### Requirement: Import Gmail Send mail as addresses
The system SHALL import a Gmail account's Send mail as addresses at `POST /api/accounts/<accountId>/identities/import`, adding each verified address other than the account's own, named by its Gmail display name or else the account name. Stored addresses and other identities SHALL stay unchanged. The response SHALL be `{ imported, identities }`. A non-Gmail account SHALL answer 400 `Only Gmail accounts have Send mail as addresses`.

#### Scenario: Import verified aliases
- **WHEN** Gmail lists the primary address, `team@example.com` verified with display name `Team`, and `new@example.com` pending
- **THEN** the import adds `team@example.com` named `Team`, reports `imported` 1, and does not add `new@example.com`

#### Scenario: Refresh is idempotent
- **WHEN** the import runs again with the same Gmail list
- **THEN** it reports `imported` 0 and the identity list is unchanged

### Requirement: Gmail Send mail as addresses are imported on connect and on demand
Connecting a Gmail account SHALL import its Send mail as addresses once; a failure there SHALL NOT fail the connection. The identity sheet SHALL offer **Import from Gmail** for Gmail accounts and show the number imported or the error.

#### Scenario: Connect a Gmail account
- **WHEN** a person connects a Gmail account with a verified Send mail as alias
- **THEN** the alias is listed as an identity without further action
