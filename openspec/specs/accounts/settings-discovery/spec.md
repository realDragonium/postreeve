# Settings Discovery Specification

## Purpose
Covers how Postreeve proposes IMAP and SMTP settings and provider guidance from an email address, so connecting many accounts needs as little manual server entry as possible, and the limits on the outbound lookups that this uses. Adding, testing and saving the account remain specified in accounts/imap-smtp-accounts.

## Requirements

### Requirement: Settings are proposed from an email address
The system SHALL answer `POST /api/accounts/discover` with body `{ email }` with `{ provider, source, settings }`. `provider` is a known provider ID or `null`; `source` is `provider`, `autoconfig`, `ispdb`, `mx` or `null`; `settings` holds `host`, `port`, `secure`, `username`, `smtpHost`, `smtpPort`, `smtpSecure` and `smtpUsername`, or `null`. An invalid email address SHALL be answered with 400.

#### Scenario: Nothing can be found
- **WHEN** no lookup produces usable settings for `person@unknown.example`
- **THEN** the response is 200 `{ provider: null, source: null, settings: null }`

#### Scenario: Not an email address
- **WHEN** the body is `{ email: "not-an-address" }`
- **THEN** the response is 400 and no lookup is made

### Requirement: Known provider domains are answered without network access
The system SHALL answer addresses at a built-in provider domain from its provider table with `source: "provider"` and make no outbound request. The table SHALL cover iCloud (`icloud.com`, `me.com`, `mac.com`), Fastmail, Yahoo, AOL, Zoho, GMX and Gmail. Proposed usernames SHALL be the full email address.

#### Scenario: iCloud address
- **WHEN** settings are requested for `person@me.com`
- **THEN** the response proposes `imap.mail.me.com` port 993 with TLS and `smtp.mail.me.com` port 587 with STARTTLS, username `person@me.com`, provider `icloud`, and no outbound request is made

### Requirement: Custom domains are looked up in a fixed order of preference
For other domains the system SHALL consult the domain's autoconfig files at `https://autoconfig.<domain>/mail/config-v1.1.xml` and `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`, then `https://autoconfig.thunderbird.net/v1.1/<domain>`, then the domain's highest-priority MX host matched against the provider table, and SHALL return the first of these that yields usable settings.

#### Scenario: Domain publishes its own autoconfig
- **WHEN** both the domain's autoconfig file and the ISPDB return usable settings
- **THEN** the response uses the domain's own settings with `source: "autoconfig"`

#### Scenario: Custom domain hosted at Fastmail
- **WHEN** no autoconfig file or ISPDB entry exists and the domain's MX host is `in1-smtp.messagingengine.com`
- **THEN** the response proposes Fastmail's servers with provider `fastmail`, `source: "mx"` and the full address as username

### Requirement: Outbound lookups are limited
Lookups SHALL use HTTPS GET only to the URLs above, built from the normalized email domain, with no credentials, cookies or email address in the request. Each request SHALL time out within 5 seconds, MUST NOT follow redirects and SHALL read at most 64 KiB. A failed, redirected, oversized or malformed answer SHALL count as no answer. Domains that are IP literals or have a single label SHALL get no lookup.

#### Scenario: Autoconfig redirects elsewhere
- **WHEN** the domain's autoconfig URL answers with a redirect
- **THEN** the redirect is not followed and the next source is tried

#### Scenario: Address at an IP literal
- **WHEN** settings are requested for `person@[127.0.0.1]` or `person@intranet`
- **THEN** no outbound request is made and nothing is proposed, or the address is rejected as invalid with 400

### Requirement: Only encrypted password servers are proposed
From an autoconfig or ISPDB document the system SHALL use the first IMAP and first SMTP server whose socket type is `SSL` (TLS) or `STARTTLS`, whose authentication is password based and whose hostname and port are valid. Usernames SHALL be expanded from `%EMAILADDRESS%`, `%EMAILLOCALPART%` and `%EMAILDOMAIN%`; any other placeholder SHALL fall back to the full address. A document without both servers SHALL count as no answer.

#### Scenario: Only an unencrypted IMAP server is published
- **WHEN** the autoconfig document lists IMAP only with socket type `plain`
- **THEN** that document is ignored

### Requirement: Providers without password sign-in are recognized
The system SHALL recognize Outlook.com/Hotmail/Live addresses and Proton Mail addresses, by domain or MX host, and return their provider ID with `settings: null`.

#### Scenario: Hotmail address
- **WHEN** settings are requested for `person@hotmail.com`
- **THEN** the response is `{ provider: "outlook", source: "provider", settings: null }`

### Requirement: The account sheet starts from the email address
When connecting a new mailbox, the sheet SHALL show name and email first with **Find settings**, which requests a proposal and fills every returned server field, replacing what was there. The sheet SHALL name the result's source or say nothing was found. Every field SHALL stay editable and connecting SHALL still verify IMAP and SMTP before saving. The Manage sheet MUST NOT offer discovery.

#### Scenario: Connecting an iCloud address
- **WHEN** a user enters `person@icloud.com` and selects **Find settings**
- **THEN** the IMAP and SMTP fields show iCloud's servers, the sheet says the settings come from Postreeve's provider list, and the user can still change any field before connecting

#### Scenario: Lookup finds nothing
- **WHEN** discovery returns no settings
- **THEN** the sheet says no settings were found and existing field values are left unchanged

### Requirement: Provider guidance is fixed text
For a recognized provider the sheet SHALL show fixed guidance: app-specific password instructions for iCloud, Fastmail, Yahoo and AOL; enabling IMAP for GMX; an explanation that Outlook.com and Proton Mail cannot be connected yet. Text from lookup responses MUST NOT be shown.

#### Scenario: Yahoo address
- **WHEN** discovery returns provider `yahoo`
- **THEN** the sheet tells the user to generate an app password in Yahoo account security and use it as the password

### Requirement: Gmail addresses are steered to Google authorization
When discovery returns provider `gmail` and Google connection is configured, the sheet SHALL recommend **Continue with Google** instead of a password. When it is not configured, the sheet SHALL explain that a Google app password is required.

#### Scenario: Gmail address on a configured server
- **WHEN** a user finds settings for `person@gmail.com` on a server with Google connection configured
- **THEN** the sheet recommends **Continue with Google**
