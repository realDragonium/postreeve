# IMAP/SMTP Accounts Specification

## Purpose
Covers listing accounts and adding, testing, editing, reconnecting and removing IMAP/SMTP accounts through the local HTTP API and the account sheet in the web interface. Removal applies to every account kind. Connecting and reauthorizing Gmail is specified in accounts/gmail-accounts; how stored credentials are encrypted in accounts/credential-vault.

## Requirements

### Requirement: Account list
The system SHALL return every configured account, IMAP and Gmail, at `GET /api/accounts` as `{ id, name, email, kind }` in the order the accounts were created, where `kind` is `imap` or `gmail`. The list MUST NOT contain credentials. A new installation SHALL have no accounts, and the web interface SHALL then ask the user to connect one.

#### Scenario: Fresh installation
- **WHEN** `GET /api/accounts` is called before any account was added
- **THEN** the response is an empty array and the web interface shows "Connect your email"

#### Scenario: Mixed accounts
- **WHEN** an IMAP account and a Gmail account are configured
- **THEN** both are listed with their `kind`, and neither entry includes a password, refresh token or server setting

### Requirement: Adding an account verifies both connections before saving
The system SHALL add an IMAP/SMTP account at `POST /api/accounts` only after authenticating to IMAP and then verifying SMTP without sending mail. The body SHALL require `kind: "imap"`, `name`, `email`, the IMAP `host`, `port`, `secure`, `username` and `password`, and the same five fields prefixed with `smtp`, and MAY include the boolean `saveSentCopy`; invalid input SHALL be answered with 400. On success the system SHALL store the encrypted credentials and settings under a new ID and answer 201 with the public account.

#### Scenario: Both servers accept the credentials
- **WHEN** a user submits valid IMAP and SMTP settings
- **THEN** the response is 201 with `{ id, name, email, kind: "imap" }` and the account appears in `GET /api/accounts`

#### Scenario: Missing SMTP password
- **WHEN** the request omits `smtpPassword`
- **THEN** the response is 400 and no connection is attempted

### Requirement: Failed connection checks store nothing and reveal no provider detail
When the IMAP check fails the system SHALL answer 400 with `IMAP connection failed. Check the server, port, TLS setting, username, and password.`; when the SMTP check fails it SHALL answer 400 with the same message starting `SMTP connection failed.`. The provider's own error text MUST NOT be returned, and the account MUST NOT be stored or registered.

#### Scenario: SMTP rejects the login
- **WHEN** IMAP accepts the credentials and SMTP rejects them
- **THEN** the response is 400 with the `SMTP connection failed.` message and `GET /api/accounts` is unchanged

#### Scenario: Provider error contains a secret
- **WHEN** the IMAP server's error message contains the submitted password
- **THEN** the returned error is the fixed IMAP message and does not contain the password

### Requirement: Connection test without saving
The system SHALL test settings without storing anything: `POST /api/accounts/test` with the same body as adding an account, and `POST /api/accounts/<accountId>/test` with the body used for updating an existing account. A successful test SHALL answer 200 `{ ok: true }`; a failed test SHALL answer with the same errors as adding an account. Testing an existing account MUST NOT change its stored settings or credentials.

#### Scenario: Testing new settings
- **WHEN** a user selects **Test connection** for valid new settings
- **THEN** the response is `{ ok: true }`, the sheet reports that IMAP and SMTP succeeded, and no account is created

#### Scenario: Testing changed settings of an existing account
- **WHEN** a user tests a different IMAP host for an existing account and then closes the sheet
- **THEN** the stored account still uses its previous host

### Requirement: Stored settings are readable without passwords
The system SHALL return an IMAP account's editable settings at `GET /api/accounts/<accountId>/settings` as `id`, `name`, `email`, `kind`, `host`, `port`, `secure`, `username`, `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUsername` and `saveSentCopy`. Stored passwords MUST NOT be returned by this or any other endpoint.

#### Scenario: Opening Manage for an IMAP account
- **WHEN** the account sheet loads an IMAP account's settings
- **THEN** every field except the two passwords is prefilled, including **Save a copy to Sent**, and the password fields are empty

### Requirement: Updating and reconnecting an account
The system SHALL update an IMAP account at `PUT /api/accounts/<accountId>` from the same fields as its settings, with `saveSentCopy` optional, plus optional `password` and `smtpPassword`. An omitted `saveSentCopy` SHALL keep the account's current value. It SHALL verify the resulting IMAP and SMTP settings as when adding an account and save them only if both checks pass, keeping the account ID and answering with the updated public account. A failed check SHALL leave the stored account unchanged.

#### Scenario: Reconnect with a new password
- **WHEN** a user enters a new IMAP password that the server accepts
- **THEN** the new password is stored encrypted and later connections use it

#### Scenario: New settings fail verification
- **WHEN** an update changes the SMTP host to one that rejects the connection
- **THEN** the response is 400 with the `SMTP connection failed.` message and the previous settings remain in use

### Requirement: Blank passwords keep the stored passwords
When an update or existing-account connection test omits `password` or `smtpPassword`, the system SHALL use the stored password for that service; a provided password SHALL replace it. The web interface SHALL omit a password field left blank and label it "leave blank to keep current".

#### Scenario: Rename without re-entering passwords
- **WHEN** a user changes only the account name and leaves both password fields blank
- **THEN** the connection checks use the stored passwords, the new name is saved and the account ID is unchanged

### Requirement: Gmail accounts are not managed through IMAP settings
The system SHALL refuse settings reads, connection tests and updates for a Gmail account with 400 `Google account access is managed through Google authorization`.

#### Scenario: Updating a Gmail account through the IMAP route
- **WHEN** `PUT /api/accounts/<accountId>` targets a Gmail account
- **THEN** the response is 400 with that message and nothing changes

### Requirement: Accounts without outgoing-mail settings must be added again
For an IMAP account stored without SMTP settings, the system SHALL refuse settings reads, connection tests and updates with 400, and sending from it SHALL fail with `This existing account has no SMTP configuration; add it again with outgoing-mail settings`.

#### Scenario: Editing an account that has no SMTP settings
- **WHEN** a user opens **Manage** for such an account
- **THEN** the settings request fails with 400 and the user must remove the account and add it again

### Requirement: Removing an account deletes its local data
The system SHALL remove an account of either kind at `DELETE /api/accounts/<accountId>`, answering `{ ok: true }`. In one transaction it SHALL delete the account and its encrypted credentials, its drafts with their stored files, its local message locations and provider associations, its Activity batches and its proposals. The web interface SHALL require a second confirmation before removing.

#### Scenario: Removing an account with history
- **WHEN** a user confirms removal of an account that has applied actions and drafts
- **THEN** the account disappears from `GET /api/accounts` and its batches, proposals and drafts can no longer be found

#### Scenario: Requests after removal
- **WHEN** a client lists folders for a removed account
- **THEN** the response is 400 with `Account not found`

### Requirement: Removing an account never changes the provider
Account removal MUST NOT delete or change anything at the mail provider: mail, folders, labels and provider copies of drafts SHALL remain, and a Google grant SHALL NOT be revoked.

#### Scenario: Mail remains after removal
- **WHEN** a user removes an account whose drafts were mirrored to the provider's Drafts folder
- **THEN** the provider still holds its mail and those draft copies

### Requirement: Removal is refused during an active draft delivery
The system SHALL refuse to remove an account while one of its drafts is being delivered, answering 409 `{ error: "Account has a draft delivery in progress", code: "account_conflict" }` and deleting nothing.

#### Scenario: Remove while sending
- **WHEN** a user removes an account while one of its drafts has delivery status `sending`
- **THEN** the response is 409 with code `account_conflict` and the account and draft remain

### Requirement: Unknown account IDs are rejected
The system SHALL answer 400 `{ error: "Account not found" }` to any account-scoped request for an account ID that does not exist.

#### Scenario: Removing an unknown account
- **WHEN** `DELETE /api/accounts/<accountId>` names an ID that was never created
- **THEN** the response is 400 with `Account not found`

### Requirement: Save a copy to Sent setting
Each IMAP account SHALL have a **Save a copy to Sent** setting, `saveSentCopy`, that controls whether sent mail is appended to its Sent mailbox (compose/sending). The account sheet SHALL show it as a checkbox in the outgoing-mail section.

#### Scenario: User overrides the default
- **WHEN** a user turns the setting on for an Office 365 account and saves
- **THEN** its settings report `saveSentCopy: true` and later sends append a copy to Sent

### Requirement: Save a copy to Sent defaults from the IMAP host
An account added without `saveSentCopy`, or stored before the setting existed, SHALL use a default from its IMAP host: off when the host, compared case-insensitively, is `gmail.com`, `googlemail.com`, `outlook.com` or `office365.com` or a subdomain of one, because those providers file SMTP submissions themselves; on otherwise. While adding an account, the checkbox SHALL follow that default until the user changes it.

#### Scenario: iCloud account
- **WHEN** a user adds an account with IMAP host `imap.mail.me.com` without choosing the setting
- **THEN** its settings report `saveSentCopy: true`

#### Scenario: Gmail over IMAP
- **WHEN** a user enters IMAP host `imap.gmail.com` in the account sheet
- **THEN** **Save a copy to Sent** is unchecked, and the saved account reports `saveSentCopy: false`

#### Scenario: Account stored before the setting existed
- **WHEN** an account saved without the setting has IMAP host `outlook.office365.com`
- **THEN** its settings report `saveSentCopy: false` and its sends append nothing
