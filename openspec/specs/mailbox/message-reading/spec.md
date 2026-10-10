# Message Reading Specification

## Purpose
Covers reading full messages: fetching bodies and attachment metadata for listed messages, showing them safely in the web interface with sanitized HTML and blocked remote images, and downloading received attachments. Message summaries and search are specified in mailbox/message-listing; canonical message and conversation IDs in conversations/message-identity and conversations/conversation-threading; files attached to outgoing drafts in compose/draft-files.

## Requirements

### Requirement: Read full messages by reference
The system SHALL read messages from the provider at `POST /api/messages/read` with `{ references }`, 1 to 100 summary references of one account, and return one detail per reference in request order: the summary fields plus `text`, `html` (or null), `attachments` and, for Gmail, `providerConversationId`. References from several accounts SHALL fail with "Messages from different accounts cannot be read in one request". Any invalid request or provider failure SHALL answer 400 with `{ error }`.

#### Scenario: Read one message
- **WHEN** the web interface reads the reference of a listed message
- **THEN** it receives one detail with that message's text, HTML and attachments

#### Scenario: Mixed accounts
- **WHEN** a client reads references from two different accounts in one request
- **THEN** the response is 400 with "Messages from different accounts cannot be read in one request"

#### Scenario: Too many references
- **WHEN** a client sends 101 references
- **THEN** the response is 400 and no message is read

### Requirement: Reading does not change mailbox state
Reading a message SHALL NOT change its read state, flags or location at the provider. IMAP folders SHALL be opened read-only for reading.

#### Scenario: Opening an unread message
- **WHEN** a person opens an unread message
- **THEN** the message is still unread at the provider and in the next list response

### Requirement: Stale references fail
Reading SHALL fail with 400 when a reference no longer identifies the listed message: on IMAP when the folder's UIDVALIDITY changed ("Mailbox <path> changed since the message was listed"), or when the UID is missing or its MODSEQ differs from the listed one ("Message UID <uid> is missing or stale in <path>"); on Gmail when the reference has no provider message ID or the provider cannot return it.

#### Scenario: Folder rebuilt since listing
- **WHEN** an IMAP folder's UIDVALIDITY changes after a message was listed and the person opens that message
- **THEN** the read fails with "Mailbox <path> changed since the message was listed"

### Requirement: Body text and HTML
The system SHALL build `text` from the message's `text/plain` body parts and `html` from its `text/html` body parts, excluding parts that are files, and SHALL set `html` to null when there is no HTML part. On IMAP, a message without plain text SHALL get `text` derived from its HTML. Inline images that the HTML references by `cid:` SHALL be embedded in `html` as `data:` URIs.

#### Scenario: HTML-only IMAP message
- **WHEN** an IMAP message has only an HTML body
- **THEN** `html` holds that body and `text` holds its text content

#### Scenario: Inline image
- **WHEN** an HTML body shows an image part through `cid:logo`
- **THEN** the returned `html` contains that image as a `data:image/...;base64` URI

### Requirement: Received attachment metadata
Each detail SHALL list in `attachments` every file part (a part with a filename or `Content-Disposition: attachment`) with `reference`, `canonicalMessageId`, `filename`, `mediaType`, `size` and `sizeIsEstimate`, without downloading its content. `reference` SHALL be opaque and bound to the account, canonical message and provider part. On Gmail `size` SHALL be the exact decoded size with `sizeIsEstimate` false; on IMAP it SHALL be estimated from the encoded size with `sizeIsEstimate` true.

#### Scenario: Metadata without download
- **WHEN** a message with a 10 MB attachment is read
- **THEN** the attachment is listed with its size and the file bytes are not fetched from the provider

### Requirement: Attachment names and types are normalized
The system SHALL report and serve an attachment's `filename` as its last path segment with control characters removed, at most 240 characters, or `attachment` when nothing remains, and its `mediaType` as the lowercased type without parameters, or `application/octet-stream` when that is not a valid media type.

#### Scenario: Path in a filename
- **WHEN** a message attaches a file named `../../etc/passwd`
- **THEN** its attachment `filename` is `passwd`

#### Scenario: Invalid media type
- **WHEN** an attachment declares the content type `not a type`
- **THEN** its `mediaType` is `application/octet-stream`

### Requirement: Download a received attachment
The system SHALL serve an attachment's decoded bytes at `GET /api/accounts/<accountId>/messages/<canonicalMessageId>/attachments/<reference>` with `Content-Type` set to the attachment's normalized media type, `Content-Disposition: attachment` with an ASCII `filename` fallback and a UTF-8 `filename*`, `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

#### Scenario: Non-ASCII filename
- **WHEN** a person downloads `résumé (Sam's)*.txt`
- **THEN** `Content-Disposition` is `attachment; filename="r_sum_ (Sam's)*.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28Sam%27s%29%2A.txt` and the body equals the original file bytes

### Requirement: Attachment references are validated before download
Before contacting the provider the system SHALL verify that the account exists, the canonical message exists, the reference decodes, and the reference names the same account, canonical message and provider as the request. It SHALL also verify that the canonical message still has the provider location the reference points to. A reference of more than 8,000 characters, a malformed or mismatched reference, or a stale location SHALL answer 400 without downloading anything.

#### Scenario: Reference used under another message
- **WHEN** a client requests a valid attachment reference under a different canonical message ID
- **THEN** the response is 400 and the provider is not asked for the file

#### Scenario: Tampered reference
- **WHEN** a client edits the account inside a reference
- **THEN** the response is 400 with "Attachment reference does not belong to this account and message"

#### Scenario: Message moved since reading
- **WHEN** the message's location in the reference is no longer one of its known locations
- **THEN** the response is 400 with "Attachment reference is stale for this message"

### Requirement: Attachment download size limit
The system SHALL refuse to serve an attachment larger than `POSTREEVE_MAX_ATTACHMENT_BYTES` decoded bytes (default 26,214,400; it MUST be a positive integer or the server does not start), answering 400 with "Attachment exceeds the <limit>-byte download limit". The limit SHALL be enforced while fetching from the provider, so an oversized file is not fully downloaded. It SHALL be independent of the outgoing upload and message limits.

#### Scenario: Oversized attachment
- **WHEN** the limit is 64 bytes and a person downloads a 65-byte attachment
- **THEN** the response is 400 with "Attachment exceeds the 64-byte download limit"

### Requirement: Reader shows the message header
When a person opens a message, the web interface SHALL show its subject (or "(No subject)"), sender name and address, To and Cc recipients, the date, and any `deliveredTo` addresses not already among the To recipients as "delivered to …". On narrow screens the reader SHALL replace the list and offer a control back to it.

#### Scenario: Catch-all address shown
- **WHEN** a message to `alex@example.com` has `deliveredTo` `planning-alias@example.com`
- **THEN** the reader shows "delivered to planning-alias@example.com"

#### Scenario: Header for each expanded conversation message
- **WHEN** a conversation message is expanded in the reader
- **THEN** it shows that message's sender name and address, recipients, Cc, delivered-to addresses and date

### Requirement: Reader lists and downloads attachments
The reader SHALL list each attachment as **Download <filename>** with its size, prefixed by `~` when estimated, and save the file under its filename when chosen. During a download every attachment button SHALL be disabled and the active one SHALL read "Downloading…"; a failed download SHALL show the server's error as an alert.

#### Scenario: Estimated size
- **WHEN** an attachment has an estimated size of 3,100 bytes
- **THEN** the reader shows `~3.0 KB`

#### Scenario: Failed attachment download
- **WHEN** the provider is unavailable during an attachment download
- **THEN** the reader shows the error message in an alert and the attachment buttons become enabled again

### Requirement: HTML mail is sanitized and isolated
The web interface SHALL sanitize `html` with DOMPurify, removing scripts, event handlers, frames, objects, embeds, forms, form controls, `base`, `link` and `meta`, and show it in a sandboxed frame without script permission whose content security policy blocks scripts, connections, forms and plugins. Only `http:`, `https:`, `mailto:`, `tel:` and `#` links SHALL keep their target, in a new tab with `noopener noreferrer`. When `html` is null or blank, the reader SHALL show `text` as plain text.

#### Scenario: Script in an email
- **WHEN** an HTML message contains a `<script>` element and an inline event handler
- **THEN** neither is present in the rendered frame and neither runs

#### Scenario: Plain-text message
- **WHEN** a message has no HTML body
- **THEN** the reader shows its text without a frame

### Requirement: Remote images are blocked until the person allows them
The web interface SHALL remove remote (`http:`, `https:` or protocol-relative) URLs from `src`, `srcset`, lazy-loading, `poster` and `background` attributes and deny remote images in the frame's content security policy, so opening a message requests nothing remote. Embedded `data:` and `blob:` images SHALL display. When any were found, the reader SHALL show "Remote images blocked to protect your privacy." with **Load images**, which loads them, CSS `url()` images included, for that message only.

#### Scenario: Tracking pixel
- **WHEN** a person opens a message containing `<img src="https://tracker.invalid/pixel.gif">`
- **THEN** no request reaches `tracker.invalid` and the blocked-images notice is shown

#### Scenario: Consent does not carry over
- **WHEN** a person loads images in one message and then opens another message with remote images
- **THEN** the second message's remote images are blocked

#### Scenario: Person loads images
- **WHEN** the person selects Load images
- **THEN** the remote images load, with protocol-relative URLs loaded over `https:`

### Requirement: Reader shows the whole conversation
When a person opens a message, the reader SHALL show every message of its conversation that has a current location (conversations/conversation-threading), in conversation order and from any folder or account, with the opened list message in place of its own entry. Until the conversation has loaded, or when it cannot be loaded, the reader SHALL show the opened message alone.

#### Scenario: Own reply from Sent
- **WHEN** a person opens an Inbox message whose conversation includes their reply in Sent
- **THEN** the reader shows the Inbox message followed by the reply

#### Scenario: Conversation unavailable
- **WHEN** the conversation request fails
- **THEN** the reader still shows the opened message with its body

### Requirement: Read conversation messages start collapsed
The reader SHALL start with the opened message and unread messages expanded and every other message collapsed to its sender, date and preview. Selecting a collapsed message SHALL expand it, and selecting an expanded message's header SHALL collapse it. The reader SHALL scroll the opened message into view.

#### Scenario: Older read message
- **WHEN** a person opens the latest message of a conversation whose earlier message is read
- **THEN** the earlier message shows only its sender, date and preview until the person selects it

### Requirement: Conversation bodies load on demand
The reader SHALL read a conversation message's body only while that message is expanded, through the same read path as the opened message, so collapsed messages request no body and no remote content. A failed read SHALL show its error inside that message only.

#### Scenario: Expanding a collapsed message
- **WHEN** a person expands a collapsed message
- **THEN** its body is read and shown, and its read state and location at the provider do not change

#### Scenario: One body fails
- **WHEN** reading one expanded message fails
- **THEN** that message shows the error and the other messages stay readable

### Requirement: Conversation messages keep reader features
Each expanded message SHALL show its own attachments, sanitized and isolated HTML or plain text, and remote-image notice with its own consent, and SHALL offer Reply, Reply all and Forward that compose from that message and its account. Mailbox actions, provenance, the position counter and keyboard shortcuts SHALL keep targeting the opened list message.

#### Scenario: Reply to an earlier message
- **WHEN** a person selects Reply on an earlier expanded message of the conversation
- **THEN** the reply is addressed from that message's sender and quotes that message

#### Scenario: Archive from a conversation
- **WHEN** a person selects Archive while reading a conversation
- **THEN** only the opened list message is archived
