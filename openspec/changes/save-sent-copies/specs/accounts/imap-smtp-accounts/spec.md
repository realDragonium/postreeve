## MODIFIED Requirements

### Requirement: Adding an account verifies both connections before saving
The system SHALL add an IMAP/SMTP account at `POST /api/accounts` only after authenticating to IMAP and then verifying SMTP without sending mail. The body SHALL require `kind: "imap"`, `name`, `email`, the IMAP `host`, `port`, `secure`, `username` and `password`, and the same five fields prefixed with `smtp`, and MAY include the boolean `saveSentCopy`; invalid input SHALL be answered with 400. On success the system SHALL store the encrypted credentials and settings under a new ID and answer 201 with the public account.

#### Scenario: Both servers accept the credentials
- **WHEN** a user submits valid IMAP and SMTP settings
- **THEN** the response is 201 with `{ id, name, email, kind: "imap" }` and the account appears in `GET /api/accounts`

#### Scenario: Missing SMTP password
- **WHEN** the request omits `smtpPassword`
- **THEN** the response is 400 and no connection is attempted

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

## ADDED Requirements

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
