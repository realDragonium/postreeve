# Spec Delta

## MODIFIED Requirements

### Requirement: Known provider domains are answered without network access
The system SHALL answer addresses at a built-in provider domain from its provider table with `source: "provider"` and make no outbound request. The table SHALL cover iCloud (`icloud.com`, `me.com`, `mac.com`), Fastmail, Yahoo, AOL, Zoho, GMX, Gmail and Proton Mail. Proposed usernames SHALL be the full email address.

#### Scenario: iCloud address
- **WHEN** settings are requested for `person@me.com`
- **THEN** the response proposes `imap.mail.me.com` port 993 with TLS and `smtp.mail.me.com` port 587 with STARTTLS, username `person@me.com`, provider `icloud`, and no outbound request is made

### Requirement: Providers without password sign-in are recognized
The system SHALL recognize Outlook.com/Hotmail/Live addresses by domain or MX host and return provider `outlook` with `settings: null`.

#### Scenario: Hotmail address
- **WHEN** settings are requested for `person@hotmail.com`
- **THEN** the response is `{ provider: "outlook", source: "provider", settings: null }`

## ADDED Requirements

### Requirement: Strato custom domains are recognized by MX
The provider table SHALL contain Strato with `imap.strato.de` port 993 and `smtp.strato.de` port 465, both with TLS, and SHALL match a domain whose highest-priority MX host is under `rzone.de`. The account sheet SHALL say that Strato signs in with the full address and the mailbox password from the Strato customer area.

#### Scenario: Custom domain hosted at Strato
- **WHEN** no autoconfig file or ISPDB entry exists and the domain's MX host is `smtpin.rzone.de`
- **THEN** the response proposes Strato's servers with provider `strato`, `source: "mx"` and the full address as username

### Requirement: Proton Mail proposes Proton Mail Bridge
For Proton Mail addresses, recognized by domain or by an MX host under `protonmail.ch`, the system SHALL propose Proton Mail Bridge's local defaults: IMAP `127.0.0.1` port 1143 and SMTP `127.0.0.1` port 1025, both with STARTTLS. The sheet SHALL tell the owner to check them and the Bridge password in the Bridge app, and to trust the Bridge's certificate after comparing its fingerprint.

#### Scenario: Proton address
- **WHEN** settings are requested for `person@proton.me`
- **THEN** the response has provider `proton` and proposes `127.0.0.1` ports 1143 and 1025 without TLS from the start
