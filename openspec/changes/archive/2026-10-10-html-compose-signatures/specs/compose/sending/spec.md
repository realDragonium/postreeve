## MODIFIED Requirements

### Requirement: Provider routing and message construction
The system SHALL send through the Gmail API `messages/send` for Gmail accounts and through the account's stored SMTP settings for IMAP accounts. Each message SHALL get a new `Message-ID` (see Outgoing Message-IDs use the sender's domain) and a UTF-8 body (see Rich-text drafts are sent as alternatives). SMTP SHALL deliver Bcc recipients through the envelope only and MUST NOT write a Bcc header. An IMAP account without stored SMTP settings SHALL fail every send before dispatch.

#### Scenario: Bcc over SMTP
- **WHEN** an IMAP account sends with one `to` and one `bcc` recipient
- **THEN** the SMTP envelope names both recipients and the transmitted headers contain no Bcc line

#### Scenario: Account without SMTP settings
- **WHEN** an IMAP account stored without SMTP settings sends a message
- **THEN** the send fails before dispatch with a message asking the user to add the account again with outgoing-mail settings

## ADDED Requirements

### Requirement: Rich-text drafts are sent as alternatives
Plain-text content SHALL be sent as a single `text/plain` part. A draft with format `html` SHALL be sent, and copied to the provider's drafts, as `multipart/alternative` with a `text/plain` part generated from the sanitized HTML followed by the sanitized `text/html` part.

#### Scenario: Rich-text draft
- **WHEN** a draft with format `html` and body `<p>Hi <b>Sam</b></p>` is sent
- **THEN** the message is `multipart/alternative` with a `text/plain` part reading `Hi Sam` and a `text/html` part containing `<b>Sam</b>`

### Requirement: Outgoing HTML is sanitized by the server
Whenever the system builds an outgoing message or provider draft copy from HTML it SHALL sanitize the HTML against an allowlist, whatever the client sent: scripts, styles sheets, frames, forms, event handler attributes and `javascript:` links SHALL be removed; links SHALL keep only `http`, `https`, `mailto` and `tel` targets; images SHALL keep only `data:image/` sources; inline styles SHALL keep only allowlisted properties without `url(`. Building the message MUST NOT fetch any remote resource.

#### Scenario: Script in a draft body
- **WHEN** a client saves a rich-text draft containing `<script>` and `<a href="javascript:alert(1)" onclick="x()">link</a>` and sends it
- **THEN** the sent HTML contains the text `link` but no script element, no `javascript:` URL and no `onclick` attribute

#### Scenario: Remote image
- **WHEN** a rich-text draft contains `<img src="https://tracker.example/p.gif">`
- **THEN** the message is built without contacting `tracker.example` and its HTML contains no remote image source
