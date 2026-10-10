# compose/identities Specification

## Purpose
Lets a person keep the addresses they send as, such as aliases and catch-all addresses, per account on the server, so every browser and the send path see the same identities.

## Requirements

### Requirement: Identities are stored per account
The system SHALL list an account's identities at `GET /api/accounts/<accountId>/identities` as `{ id, accountId, name, address, createdAt }` ordered by creation, and add one at `POST` with `{ name, address }`, answering 201. `name` SHALL be 1 to 120 characters after trimming and `address` a valid email address stored in lower case. An account SHALL hold at most 100 identities. Invalid input SHALL be answered 400.

#### Scenario: Add an alias
- **WHEN** a client posts `{ name: "Sales", address: "Sales@Example.test" }` to an account
- **THEN** the response is 201 and the account's identity list contains `sales@example.test` named `Sales`

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
The system SHALL remove an identity at `DELETE /api/accounts/<accountId>/identities/<identityId>`, answering `{ ok: true }` also when it no longer exists. Removing an account SHALL remove its identities. Drafts keep the identity they were saved with.

#### Scenario: Remove an alias
- **WHEN** a client removes an account's identity
- **THEN** it no longer appears in the identity list and a draft saved with it can no longer be sent

#### Scenario: Account removed
- **WHEN** an account with identities is removed
- **THEN** its identities are deleted with it

### Requirement: Identities are managed in the web interface
The identity sheet SHALL list the account's primary address and its server identities and SHALL add and remove identities through the API, showing any error. The compose From selector SHALL offer the primary address and the account's identities, plus a saved draft's identity when it is neither. For Gmail accounts the sheet SHALL state that only addresses verified under Gmail's Send mail as setting can send.

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
