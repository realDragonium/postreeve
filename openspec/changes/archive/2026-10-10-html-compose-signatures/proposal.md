# Proposal

## Why

Postreeve is meant to replace Apple Mail for a person with many addresses. Compose is plain text only: formatting cannot be written, replies and forwards flatten the quoted message's HTML to text, and there are no signatures, so every message from every identity needs its sign-off typed by hand.

## What Changes

- Compose has a rich-text mode with bold, italic, links, bulleted and numbered lists and block quotes. It is the default; a plain-text mode stays available and converts in both directions.
- Drafts gain `format` (`plain` or `html`). Existing drafts read as `plain` and keep working unchanged.
- A rich-text draft is sent, and mirrored to the provider, as `multipart/alternative`: a `text/plain` part generated from the HTML and a `text/html` part. The server sanitizes the HTML against a strict allowlist when it builds the MIME, whatever the client sent. Remote resources are never fetched (`disableUrlAccess` stays).
- Reply and forward in rich-text mode quote the source message's HTML, cleaned with the reader's sanitizer and stripped of remote resources and style sheets; a source without HTML is quoted as escaped text.
- One optional HTML signature per sending address (primary address and each identity), stored on the server and edited in the identity sheet. Compose inserts the From address's signature and swaps it when From changes, unless the user has edited the signature.
- `POST /api/messages/send` and the WebMCP `send_message` tool stay plain text: agents send short approved messages, and accepting agent-written HTML would widen the approval surface for little gain. agents/webmcp-tools does not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `compose/drafts`: draft `format`, rich-text compose and plain-text mode, HTML quoting, signature insertion and swapping.
- `compose/sending`: rich-text drafts are sent as sanitized `multipart/alternative`.
- `compose/identities`: per-address signatures stored on the server and managed in the identity sheet.

## Impact

Shared contracts, SQLite store (draft `body_format` column, new `signatures` table), outgoing MIME construction (SMTP, Gmail send, provider-draft copies), core draft send, HTTP API, web compose form, identity sheet, reader sanitizer (extracted for reuse), e2e tests and FEATURES.md. New runtime dependencies: `sanitize-html` and `html-to-text` (the latter already present through `mailparser`). Linear issue: none named for this run.
