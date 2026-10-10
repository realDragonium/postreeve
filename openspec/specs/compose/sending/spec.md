# Sending Specification

## Purpose
Covers dispatching new messages, replies, reply-all messages and forwards through the Gmail API or SMTP, both through `POST /api/messages/send` and as the dispatch step of sending a saved draft. Draft delivery state and the web compose form are specified in compose/drafts; uploaded files in compose/draft-files; how a sent reply joins its conversation in conversations/conversation-threading; the agent-facing `send_message` tool in agents/webmcp-tools.

## Requirements

### Requirement: Send request validation
The system SHALL accept `POST /api/messages/send` with `{ accountId, to, cc, bcc, subject, text, intent? }` and answer 201 with a send receipt. `to` SHALL hold 1 to 100 recipients and `cc` and `bcc` up to 100 each (default empty), every recipient being `{ name, address }` with a valid email address and a name of at most 120 characters. `subject` SHALL be at most 998 characters and `text` 1 to 2,000,000. An invalid request SHALL be answered 400 and nothing dispatched.

#### Scenario: Invalid recipient address
- **WHEN** a client sends with a `cc` entry whose address is `pending@`
- **THEN** the response is 400 and no mail is submitted to the provider

#### Scenario: Too many recipients in one field
- **WHEN** a client sends with 101 entries in `to`
- **THEN** the response is 400 and no mail is submitted

#### Scenario: Empty body
- **WHEN** a client sends with `text` set to an empty string
- **THEN** the response is 400 and no mail is submitted

### Requirement: Provider routing and message construction
The system SHALL send through the Gmail API `messages/send` for Gmail accounts and through the account's stored SMTP settings for IMAP accounts. Each message SHALL get a new `Message-ID` (see Outgoing Message-IDs use the sender's domain) and a UTF-8 plain-text body. SMTP SHALL deliver Bcc recipients through the envelope only and MUST NOT write a Bcc header. An IMAP account without stored SMTP settings SHALL fail every send before dispatch.

#### Scenario: Bcc over SMTP
- **WHEN** an IMAP account sends with one `to` and one `bcc` recipient
- **THEN** the SMTP envelope names both recipients and the transmitted headers contain no Bcc line

#### Scenario: Account without SMTP settings
- **WHEN** an IMAP account stored without SMTP settings sends a message
- **THEN** the send fails before dispatch with a message asking the user to add the account again with outgoing-mail settings

### Requirement: Outgoing Message-IDs use the sender's domain
Every sent message SHALL have a `Message-ID` of the form `<uuid@domain>`, where `domain` is the domain of the From address, lower-cased and converted to its ASCII (IDNA) form.

#### Scenario: Message-ID uses the sender's domain
- **WHEN** an account whose email is `person@Example.TEST` sends a message
- **THEN** the transmitted `Message-ID` ends in `@example.test>` and the receipt's `messageId` is the same value

### Requirement: Send receipts report accepted and rejected recipients
A successful send SHALL return `{ id, accountId, messageId, providerConversationId?, accepted, rejected, submittedAt, warning? }`. SMTP SHALL report the addresses the server accepted and refused; Gmail SHALL report every recipient as accepted, with `id` the Gmail message ID and `providerConversationId` the thread Gmail reports. A receipt naming another account SHALL be treated as a failure. The web interface SHALL show the accepted count, the rejected addresses and any warning.

#### Scenario: Partial SMTP refusal
- **WHEN** an SMTP server accepts one recipient and refuses another
- **THEN** the receipt lists the first in `accepted` and the second in `rejected`, and the web interface shows `Rejected:` followed by the refused address

#### Scenario: Gmail places the message in another thread
- **WHEN** Gmail reports a thread ID for the sent message different from the one requested
- **THEN** the receipt's `providerConversationId` is the thread Gmail reported

### Requirement: Conversation send intents
A send without `intent` SHALL be a new message. An `intent` `{ type: "reply" | "reply_all" | "forward", source: { canonicalMessageId, conversationId, providerConversationId? } }` SHALL name a source message that exists, belongs to that conversation and was observed through the sending account, even if it no longer has any provider location; otherwise the send SHALL be refused with 400 before dispatch.

#### Scenario: Unknown source
- **WHEN** a client replies naming a canonical message ID that does not exist
- **THEN** the response is 400 `Conversation send source was not found`

#### Scenario: Source from another account
- **WHEN** a client replies from account A to a message only ever observed through account B
- **THEN** the response is 400 `Conversation send source does not belong to the selected account`

#### Scenario: Source moved away from every folder
- **WHEN** a client replies to a message whose last known location was removed by a later folder listing
- **THEN** the reply is sent with its threading headers

### Requirement: Replies carry threading headers
For `reply` and `reply_all` the system SHALL set `In-Reply-To` to the source's Message-ID and `References` to the source's ancestry followed by the source's Message-ID. The ancestry SHALL be the source's References, or, when it has none, its single In-Reply-To identifier. When the source has no Message-ID and no ancestry, both headers SHALL be omitted. A `forward` SHALL carry neither header.

#### Scenario: Source without References
- **WHEN** a user replies to a message with `In-Reply-To: <earlier@example.test>`, no References and Message-ID `<source@example.test>`
- **THEN** the reply has `In-Reply-To: <source@example.test>` and `References: <earlier@example.test> <source@example.test>`

#### Scenario: Forward
- **WHEN** a user forwards a message
- **THEN** the sent message has no In-Reply-To or References header

### Requirement: Gmail thread placement follows the reply subject
For a Gmail reply the system SHALL request the source's Gmail thread only when the reply has an In-Reply-To header, the source can be read in that thread, and the subject equals the source subject prefixed with `Re: ` (kept as is when it already starts with `Re:`, case-insensitively); otherwise Gmail SHALL place the message. A source in several Gmail threads with none named, or a named thread the source no longer belongs to, SHALL be refused with 400.

#### Scenario: Edited reply subject
- **WHEN** a user replies through Gmail and changes the subject to something other than `Re: <source subject>`
- **THEN** the message keeps its reply headers but no thread is requested from Gmail

#### Scenario: Source unreadable
- **WHEN** every read of the source message through Gmail fails
- **THEN** the reply is still sent without a requested thread

#### Scenario: Source in several threads
- **WHEN** a reply names no Gmail thread and the source belongs to two Gmail threads
- **THEN** the response is 400 asking for a specific source location and nothing is dispatched

### Requirement: Failures are classified as pre-dispatch or uncertain
The system SHALL treat a send failure as pre-dispatch only when the provider provably received no message: MIME construction failure including the size limit, no Gmail access token, SMTP refusal of `MAIL FROM` or of every `RCPT TO`, or missing SMTP settings. Every other failure after submission started SHALL be uncertain, because the message may have been delivered. `POST /api/messages/send` SHALL answer both with 400 `{ error }`; drafts record them as specified in compose/drafts.

#### Scenario: Every SMTP recipient refused
- **WHEN** the SMTP server answers `550` to every `RCPT TO`
- **THEN** the failure is pre-dispatch and a draft send is recorded as `failed`

#### Scenario: Connection lost after DATA
- **WHEN** the SMTP connection closes after the message body was transmitted and before the server's reply
- **THEN** the failure is uncertain and a draft send is recorded as `uncertain`

### Requirement: Encoded message size limit
The system SHALL refuse to dispatch a message whose complete encoded MIME form, including headers, body, base64 attachment encoding and multipart overhead, exceeds `POSTREEVE_MAX_MESSAGE_BYTES` (default 26,214,400 bytes), failing before dispatch with `The complete encoded message exceeds the <limit>-byte message limit`. The setting MUST be a positive integer; otherwise the server SHALL refuse to start. The limit SHALL apply to Gmail and SMTP alike and does not override a provider's own limits.

#### Scenario: Message one byte over the limit
- **WHEN** the encoded message is one byte larger than `POSTREEVE_MAX_MESSAGE_BYTES`
- **THEN** nothing is submitted to the provider and the error names the byte limit

#### Scenario: Invalid setting
- **WHEN** the server starts with `POSTREEVE_MAX_MESSAGE_BYTES=0`
- **THEN** the server does not start

### Requirement: Conversation sends are recorded locally
When a reply, reply-all or forward is accepted for at least one recipient, the system SHALL record the sent message under its Message-ID: a reply or reply-all in the source's conversation, with the Gmail thread from the receipt when present, and a forward in a conversation of its own. New messages, and sends no recipient accepted, SHALL NOT be recorded. When recording fails, the send SHALL still succeed with a receipt warning.

#### Scenario: Reply appears in its conversation
- **WHEN** a reply is accepted for delivery
- **THEN** `GET /api/conversations/<conversationId>` for the source's conversation includes the sent message

#### Scenario: Local recording fails
- **WHEN** a reply is accepted but its local conversation cannot be updated
- **THEN** the receipt's `warning` reads `Message was accepted for delivery, but its local conversation could not be updated: <reason>` and the message is not sent again

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

### Requirement: Mail is sent from the selected identity
A sent draft SHALL use its identity as From, with the stored identity name when the draft's name is empty. `POST /api/messages/send` has no From field and SHALL use the account's display name and primary address. SMTP SHALL use the From address as envelope sender; a server refusing it fails before dispatch. The resolved From SHALL be the sender address for every header derived from it.

#### Scenario: Reply from an alias over SMTP
- **WHEN** an IMAP account sends a reply draft whose identity is its stored identity `sales@example.test`
- **THEN** the message has `From: Sales <sales@example.test>` and the SMTP `MAIL FROM` is `sales@example.test`

#### Scenario: Direct send
- **WHEN** a client sends through `POST /api/messages/send`
- **THEN** the message is sent from the account's display name and primary address

### Requirement: Gmail sends only from verified Send-as addresses
Before sending a Gmail message whose From address is not the account's address, the system SHALL read the account's Send-as addresses through the Gmail API and SHALL refuse before dispatch, unless the address is listed and not pending verification, with `Gmail does not allow sending as <address>; add and verify it under Gmail Settings > Accounts > Send mail as`. A failure to read the list SHALL also fail before dispatch.

#### Scenario: Verified alias
- **WHEN** a Gmail draft is sent from `alias@example.test` and Gmail lists it as an accepted Send-as address
- **THEN** the message is submitted with `From: <alias@example.test>` as chosen

#### Scenario: Address not configured in Gmail
- **WHEN** a Gmail draft is sent from a stored identity Gmail does not list as Send-as
- **THEN** nothing is submitted and the draft is recorded as `failed` with the Send mail as message

### Requirement: Sent copies use bounded IMAP timeouts
Saving a Sent copy SHALL give up when no usable IMAP connection is established within 30 seconds or when the server sends nothing for 60 seconds, and SHALL report that as a Sent copy failure.

#### Scenario: Stalled IMAP server
- **WHEN** the IMAP server stops responding while the Sent copy is appended
- **THEN** the send completes after the inactivity timeout with the Sent-copy warning, and a sent draft stays `sent`
