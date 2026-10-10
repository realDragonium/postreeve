## MODIFIED Requirements

### Requirement: Removing identities
The system SHALL remove an identity at `DELETE /api/accounts/<accountId>/identities/<identityId>`, answering `{ ok: true }` also when it no longer exists, together with its signature. Removing an account SHALL remove its identities and signatures. Drafts keep the identity they were saved with.

#### Scenario: Remove an alias
- **WHEN** a client removes an account's identity
- **THEN** it no longer appears in the identity list, its signature is no longer listed, and a draft saved with it can no longer be sent

#### Scenario: Account removed
- **WHEN** an account with identities is removed
- **THEN** its identities and signatures are deleted with it

## ADDED Requirements

### Requirement: Signatures are stored per sending address
The system SHALL list signatures at `GET /api/accounts/<accountId>/signatures` as `[{ address, html }]` and store one with `PUT` and `{ address, html }`, answering with it. `address` SHALL be the primary address or an identity, case-insensitive and stored in lower case, otherwise 400 `Signatures can only be set for the account's own addresses`. `html` SHALL be at most 100,000 characters; a blank `html` SHALL remove the signature.

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
