# Spec Delta

## MODIFIED Requirements

### Requirement: Failed connection checks store nothing and reveal no provider detail
When the IMAP check fails the system SHALL answer 400 with `IMAP connection failed. Check the server, port, TLS setting, username, and password.`; when the SMTP check fails it SHALL answer 400 with the same message starting `SMTP connection failed.`, except for certificate failures (see certificate review). The provider's own error text MUST NOT be returned, and the account MUST NOT be stored or registered.

#### Scenario: SMTP rejects the login
- **WHEN** IMAP accepts the credentials and SMTP rejects them
- **THEN** the response is 400 with the `SMTP connection failed.` message and `GET /api/accounts` is unchanged

#### Scenario: Provider error contains a secret
- **WHEN** the IMAP server's error message contains the submitted password
- **THEN** the returned error is the fixed IMAP message and does not contain the password

### Requirement: Stored settings are readable without passwords
The system SHALL return an IMAP account's editable settings at `GET /api/accounts/<accountId>/settings` as `id`, `name`, `email`, `kind`, `host`, `port`, `secure`, `username`, `smtpHost`, `smtpPort`, `smtpSecure`, `smtpUsername`, `saveSentCopy`, and the trusted certificate fingerprints `imapTrustedCertificate` and `smtpTrustedCertificate` (or `null`). Stored passwords MUST NOT be returned by this or any other endpoint.

#### Scenario: Opening Manage for an IMAP account
- **WHEN** the account sheet loads an IMAP account's settings
- **THEN** every field except the two passwords is prefilled, including **Save a copy to Sent**, and the password fields are empty

## ADDED Requirements

### Requirement: Unverifiable certificates are shown for review
When an add, test or update fails because the IMAP or SMTP server's certificate cannot be verified, the system SHALL read the presented certificate without sending credentials and answer 400 with `code: "certificate_untrusted"` and `certificate: { service, host, port, fingerprint, subject, issuer, validFrom, validTo, selfSigned }`, where `fingerprint` is the SHA-256 in lower-case hex. Nothing SHALL be stored.

#### Scenario: Self-signed poste.io server
- **WHEN** a user tests settings for an IMAP server with a self-signed certificate
- **THEN** the response is 400 with `certificate_untrusted` and the certificate's fingerprint, and no account exists

### Requirement: Trusting a certificate pins it
Add, test and update SHALL accept `imapTrustedCertificate` and `smtpTrustedCertificate` fingerprints, with or without colons. The system SHALL read the certificate the server presents again and pin it in the account's encrypted credentials only when its fingerprint equals the given one; otherwise it SHALL answer `certificate_untrusted` with the newly presented certificate. On update an absent fingerprint SHALL keep the stored pin and `null` SHALL remove it.

#### Scenario: Certificate swapped after review
- **WHEN** a user trusts a fingerprint but the server now presents another certificate
- **THEN** the request fails with `certificate_untrusted` carrying the other certificate and nothing is pinned

### Requirement: Pinned connections verify the exact certificate
A pinned IMAP, IMAP IDLE or SMTP connection SHALL keep certificate verification on, trust the pinned certificate in addition to the public roots, and accept the server only when its certificate has the pinned fingerprint, also when the host is an IP address the certificate does not name. Verification SHALL never be disabled for a connection that sends credentials.

#### Scenario: Server reached by tailnet IP
- **WHEN** an account with a pinned self-signed certificate connects to `100.64.0.5`
- **THEN** the connection succeeds without a host-name match

### Requirement: A changed certificate fails loudly
When a pinned server presents a different certificate, a test or update SHALL answer `certificate_untrusted` with a message that the certificate changed and no longer matches the trusted one, and background synchronization SHALL classify the failure as reauthorization-required, pausing automatic retries.

#### Scenario: Certificate renewed on the server
- **WHEN** the self-hosted server starts presenting a new certificate
- **THEN** synchronization reports reauthorization required and the account sheet shows the new certificate for review

### Requirement: The account sheet reviews certificates
The account sheet SHALL show a presented certificate's host, port, fingerprint as colon-separated hex, subject, issuer, validity and whether it is self-signed or expired, with **Trust this certificate** for that service, and SHALL send the fingerprint with the next test or save. For a stored pin it SHALL show the fingerprint with **Stop trusting**.

#### Scenario: Trust and retest
- **WHEN** a user checks Trust this certificate for IMAP and selects Test connection again
- **THEN** the test request carries `imapTrustedCertificate` with the reviewed fingerprint
