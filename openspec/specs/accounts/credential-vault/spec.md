# Credential Vault Specification

## Purpose
Covers how Postreeve protects stored account credentials: AES-256-GCM encryption under `POSTREEVE_MASTER_KEY`, generating that key locally without printing it, and what happens when the key is missing, malformed, lost or changed. Account management is specified in accounts/imap-smtp-accounts and accounts/gmail-accounts; how the desktop app generates and stores its key in runtime/desktop-app.

## Requirements

### Requirement: Credentials are encrypted before they are stored
The system SHALL encrypt each account's credentials with AES-256-GCM before writing them to the SQLite database, using a fresh random 12-byte IV for every encryption and storing only the IV, ciphertext and 16-byte authentication tag. Plaintext passwords and refresh tokens MUST NOT be written to the database.

#### Scenario: Stored IMAP account
- **WHEN** an IMAP account is added
- **THEN** its database record contains an encrypted envelope that does not contain the IMAP or SMTP password

#### Scenario: Same credentials saved twice
- **WHEN** identical credentials are encrypted twice
- **THEN** the two envelopes differ because each uses a new IV

### Requirement: What the vault protects
The encrypted credentials SHALL hold the IMAP and SMTP host, port, TLS setting, username and password of an IMAP account and the refresh token of a Gmail account. The account's ID, name, email address and kind SHALL be stored unencrypted.

#### Scenario: Gmail account record
- **WHEN** a Gmail account is connected
- **THEN** its refresh token exists only inside the encrypted envelope and its email address is stored in plain text

### Requirement: The encryption key comes from POSTREEVE_MASTER_KEY
The system SHALL read the key from `POSTREEVE_MASTER_KEY` as base64 that decodes to exactly 32 bytes. A set key of any other length SHALL stop the server from starting with `POSTREEVE_MASTER_KEY must be a base64-encoded 32-byte key`. When the variable is unset or empty the server SHALL start, but storing or reading credentials SHALL fail with `Set POSTREEVE_MASTER_KEY before adding or using mail accounts`.

#### Scenario: Adding an account without a key
- **WHEN** a user adds an IMAP account on a server started without `POSTREEVE_MASTER_KEY`
- **THEN** the request fails with 400 and the message to set `POSTREEVE_MASTER_KEY`, and no account is stored

#### Scenario: Truncated key
- **WHEN** the server starts with a key that decodes to 16 bytes
- **THEN** startup fails with the 32-byte key error

### Requirement: Credentials are readable only with the key that encrypted them
The system SHALL authenticate every stored envelope on decryption and MUST reject an envelope that was encrypted under a different key, was modified, or has a tag that is not 16 bytes. Because the server decrypts every stored account's credentials during startup, a lost or changed key SHALL stop the server from starting while any account is stored. The system SHALL provide no way to recover credentials without the original key.

#### Scenario: Key replaced after accounts were added
- **WHEN** the server restarts with a different valid key while accounts are stored
- **THEN** startup fails and no credentials are decrypted

### Requirement: Local setup generates a key without printing it
`bun run setup:local` SHALL create the `data` directory and, when `.env` does not exist, create `.env` with file mode 0600 containing a newly generated random 32-byte base64 `POSTREEVE_MASTER_KEY` together with `POSTREEVE_DB_PATH=./data/postreeve.sqlite`, `POSTREEVE_HOST=127.0.0.1`, `PORT=3000`, `POSTREEVE_MAX_ATTACHMENT_BYTES=26214400`, `POSTREEVE_MAX_UPLOAD_BYTES=20971520` and `POSTREEVE_MAX_MESSAGE_BYTES=26214400`. It MUST NOT print the key and MUST NOT overwrite an existing `.env`.

#### Scenario: First setup
- **WHEN** a user runs `bun run setup:local` in a checkout without `.env`
- **THEN** `.env` is created with a key and the output says the encryption key was not printed

#### Scenario: Setup run again
- **WHEN** `.env` already exists
- **THEN** the file and its key are left unchanged and only the data directory is ensured

### Requirement: Stored secrets never leave the server
The system MUST NOT include a stored password, refresh token or the master key in any API response, including account lists, account settings and error messages.

#### Scenario: Inspecting account responses
- **WHEN** a client reads `GET /api/accounts` and `GET /api/accounts/<accountId>/settings`
- **THEN** neither response contains a password, refresh token or key material

### Requirement: Credentials written by earlier versions remain readable
The system SHALL read a stored envelope that predates the account-kind field as IMAP credentials, with SMTP settings when the record contains them and without SMTP settings otherwise.

#### Scenario: Account stored before Gmail support
- **WHEN** the server starts with an IMAP account whose envelope has no `kind`
- **THEN** the account loads as an IMAP account
