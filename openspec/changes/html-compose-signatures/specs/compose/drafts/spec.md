## MODIFIED Requirements

### Requirement: Draft content and scope
The system SHALL store each draft for one account as `{ id, accountId, mode, to, cc, bcc, subject, format, body, identity, source?, attachments, delivery, mirror, createdAt, updatedAt, version }` with `mode` `new`, `reply`, `reply_all` or `forward` and `format` `plain` or `html`. A draft saved without `format`, including every draft stored before formats existed, SHALL have format `plain`. Each recipient field SHALL be raw text kept exactly as typed or a list of up to 100 `{ name, address }`. `subject` SHALL be at most 998 and `body` at most 2,000,000 characters. A draft SHALL be visible only under its own account.

#### Scenario: Unfinished recipient text survives
- **WHEN** a draft is saved with `to` set to `  alice@  `
- **THEN** reading it back returns `to` as `  alice@  ` unchanged

#### Scenario: Draft requested under another account
- **WHEN** a client reads a draft ID under an account that does not own it
- **THEN** the response is 404 `{ error: "Draft not found", code: "draft_not_found" }`

#### Scenario: Draft stored before formats existed
- **WHEN** a client reads a draft saved before this change
- **THEN** its format is `plain` and its body is unchanged

### Requirement: Compose modes start from the source message
The web interface SHALL open reply, reply-all and forward forms from a message and store the mode and source with the draft. A reply SHALL address the source's Reply-To, or else its From, without the account's own addresses, its primary address and identities, and quote the source; reply-all SHALL also copy the source's other To and Cc addresses to Cc; a forward SHALL start without recipients, with a `Fwd: ` subject and the forwarded message in the body. In rich-text mode the quote or forwarded message SHALL be the source's HTML, sanitized with the reader's rules and stripped of style sheets and remote resources, or the source's text, escaped, when it has no HTML.

#### Scenario: Reply-all recipients
- **WHEN** a user replies all to a message from Alice to the user and Bob, with Carol in Cc
- **THEN** To holds Alice and Cc holds Bob and Carol, without the user's own address

#### Scenario: Conversation draft without its source
- **WHEN** a user opens a reply draft that has no source
- **THEN** sending is unavailable, **Convert to a new message** changes its mode to `new`, and sending it unconverted through the API answers 400 `Conversation draft source was not found`

#### Scenario: Reply to an HTML message
- **WHEN** a user replies to a message whose HTML contains a table, a script and a remote image
- **THEN** the quote keeps the table, contains no script, and no request is made for the remote image

### Requirement: Sending a draft is validated before dispatch
The system SHALL send a draft at `POST /api/accounts/<accountId>/drafts/<draftId>/send` with `{ version }`, answering with the send receipt. Before dispatch it SHALL refuse, leaving the draft unchanged: a stale version or a draft in `sending` or `uncertain` with 409 `draft_conflict`, and with 400 a file without stored content, an identity the account does not have, raw recipients that do not split on commas into valid addresses, an empty To or body, or an invalid source. A rich-text body SHALL count as empty when its sanitized HTML has no text.

#### Scenario: Unparseable raw recipients
- **WHEN** a draft whose `to` is `alice@` is sent
- **THEN** the response is 400, nothing is dispatched and the stored `to` is still `alice@`

#### Scenario: Send already in progress
- **WHEN** a client sends a draft whose delivery is `sending`
- **THEN** the response is 409 `draft_conflict` and nothing is dispatched

#### Scenario: Identity that is not stored
- **WHEN** a client sends a draft whose identity address is `other@example.test` and the account has no such identity
- **THEN** the response is 400 `Draft identity does not belong to the selected account` and nothing is dispatched

#### Scenario: Rich-text draft with only markup
- **WHEN** a draft with format `html` and body `<p><br></p>` is sent
- **THEN** the response is 400 and nothing is dispatched

## ADDED Requirements

### Requirement: Rich-text compose with a plain-text mode
The compose form SHALL open new messages, replies and forwards in rich-text mode, offering bold, italic, link, bulleted list, numbered list and quote, and SHALL save them with format `html`. Pasted HTML SHALL be sanitized like a quote before it is inserted. **Plain text** SHALL convert the content to text, dropping formatting, and save with format `plain`; **Rich text** SHALL convert text back to HTML. A draft SHALL reopen in its saved format.

#### Scenario: Bold text
- **WHEN** a user selects a word, chooses Bold and sends
- **THEN** the saved draft has format `html` with the word inside `<b>` and the sent message carries a `text/html` part

#### Scenario: Plain draft from before this change
- **WHEN** a user opens a draft stored as `plain`
- **THEN** the form shows it in plain-text mode with the body unchanged

### Requirement: Compose inserts and swaps the From signature
A compose form opened without a saved draft SHALL insert the From address's signature, if any, after an empty first line and before any quote. Changing From SHALL replace, insert or remove the inserted signature to match the new address without changing other content, and SHALL leave a signature the user edited. In plain-text mode the signature SHALL follow a `-- ` line. A new message holding only its inserted signature SHALL NOT be saved as a draft.

#### Scenario: From changed before typing a sign-off
- **WHEN** a user types a body, then changes From from the primary address to an alias with another signature
- **THEN** the typed body is unchanged and the primary signature is replaced by the alias's signature

#### Scenario: Edited signature
- **WHEN** a user edits the inserted signature and then changes From
- **THEN** the edited signature stays as typed

#### Scenario: Opening and closing a new message
- **WHEN** a user opens a new message that starts with a signature and closes it without typing
- **THEN** no draft is created
