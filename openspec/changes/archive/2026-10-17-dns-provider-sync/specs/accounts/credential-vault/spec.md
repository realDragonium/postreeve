# Spec Delta

## MODIFIED Requirements

### Requirement: What the vault protects
The encrypted credentials SHALL hold the IMAP and SMTP host, port, TLS setting, username and password of an IMAP account, the refresh token of a Gmail account, the API key or admin username and password of a connected mail server, and the API token or key and secret of a DNS provider. The account's ID, name, email address and kind, the mail server's ID, name, admin URL, credential kind and mail hostname, and the DNS provider's ID, name and kind, SHALL be stored unencrypted.

#### Scenario: Gmail account record
- **WHEN** a Gmail account is connected
- **THEN** its refresh token exists only inside the encrypted envelope and its email address is stored in plain text

#### Scenario: Mail server record
- **WHEN** a Stalwart server is connected with an API key
- **THEN** its database record contains an encrypted envelope that does not contain the API key, and its admin URL is stored in plain text

#### Scenario: DNS provider record
- **WHEN** a Cloudflare provider is connected with an API token
- **THEN** its database record contains an encrypted envelope that does not contain the token, and its kind `cloudflare` is stored in plain text
