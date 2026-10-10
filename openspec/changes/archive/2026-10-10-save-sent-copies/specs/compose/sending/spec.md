## MODIFIED Requirements

### Requirement: Provider routing and message construction
The system SHALL send through the Gmail API `messages/send` for Gmail accounts and through the account's stored SMTP settings for IMAP accounts. Each message SHALL get a new `Message-ID` (see Outgoing Message-IDs use the sender's domain) and a UTF-8 plain-text body. SMTP SHALL deliver Bcc recipients through the envelope only and MUST NOT write a Bcc header. An IMAP account without stored SMTP settings SHALL fail every send before dispatch.

#### Scenario: Bcc over SMTP
- **WHEN** an IMAP account sends with one `to` and one `bcc` recipient
- **THEN** the SMTP envelope names both recipients and the transmitted headers contain no Bcc line

#### Scenario: Account without SMTP settings
- **WHEN** an IMAP account stored without SMTP settings sends a message
- **THEN** the send fails before dispatch with a message asking the user to add the account again with outgoing-mail settings

## ADDED Requirements

### Requirement: Outgoing Message-IDs use the sender's domain
Every sent message SHALL have a `Message-ID` of the form `<uuid@domain>`, where `domain` is the domain of the From address, lower-cased and converted to its ASCII (IDNA) form.

#### Scenario: Message-ID uses the sender's domain
- **WHEN** an account whose email is `person@Example.TEST` sends a message
- **THEN** the transmitted `Message-ID` ends in `@example.test>` and the receipt's `messageId` is the same value

### Requirement: Sent copies for IMAP accounts
When an IMAP account whose **Save a copy to Sent** setting is on (accounts/imap-smtp-accounts) sends a message, through `POST /api/messages/send` or a draft, that at least one recipient accepted, the system SHALL append the exact MIME it transmitted over SMTP, flagged `\Seen` and dated with the receipt's `submittedAt`, to the account's selectable special-use Sent mailbox. Otherwise, and for Gmail accounts, nothing SHALL be appended.

#### Scenario: Copy saved
- **WHEN** an IMAP account with the setting on sends a message with a Bcc recipient that its server accepts
- **THEN** the Sent mailbox receives the transmitted message, without a Bcc line, flagged `\Seen`, and the receipt has no warning

#### Scenario: Provider files sent mail itself
- **WHEN** an account whose setting is off sends a message
- **THEN** nothing is appended to its Sent mailbox

#### Scenario: Every recipient refused
- **WHEN** the SMTP server refuses every recipient
- **THEN** nothing is appended to Sent

### Requirement: Sent copies are indexed into their conversation
When the server reports the UID of an appended Sent copy, the system SHALL index that copy at once, so `Sent` lists it with the canonical message and conversation the send recorded (conversations/conversation-threading), matched by Message-ID. When no UID is reported, synchronization SHALL index it later.

#### Scenario: Reply listed in Sent
- **WHEN** a reply's Sent copy is appended and the server reports its UID
- **THEN** `Sent` immediately lists the reply with the canonical ID and `conversationId` recorded for it

### Requirement: Sent copy failures do not fail the send
A failure to append or index a Sent copy SHALL NOT turn the send into a failure or allow it to be sent again. The receipt SHALL carry `Message was sent, but a copy could not be saved to Sent: <reason>`, after any other warning, and a sent draft SHALL keep that warning in its stored receipt.

#### Scenario: Append fails after delivery
- **WHEN** the SMTP server accepts a draft's message and the IMAP append is refused
- **THEN** the draft is recorded as `sent` with that warning in its receipt and nothing is sent again

#### Scenario: No Sent mailbox
- **WHEN** the account has no selectable mailbox marked `\Sent`
- **THEN** the send succeeds with the Sent-copy warning naming the missing Sent mailbox
