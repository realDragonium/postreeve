# Spec Delta

## ADDED Requirements

### Requirement: Identity, signature and draft reading tools
`list_identities` and `list_signatures` SHALL take `{ accountId }` and return the account's stored identities and signatures. `list_drafts` SHALL take `{ accountId }` and `read_draft` `{ accountId, draftId }`, returning drafts as `GET /api/accounts/<id>/drafts` does. All four SHALL be read-only.

#### Scenario: Pick a sending identity
- **WHEN** an agent lists identities for an account with an alias identity
- **THEN** the alias address and name are returned

### Requirement: Attachment content tool
`read_attachment` SHALL take `{ accountId, canonicalMessageId, reference }` from a message detail and return `{ mediaType, size, encoding, content }`: text for `text/*`, JSON and XML media types, otherwise base64. It SHALL refuse attachments over 5 MiB and SHALL use the same account and reference checks as the download endpoint.

#### Scenario: Read a text attachment
- **WHEN** an agent reads a `text/plain` attachment
- **THEN** `encoding` is `text` and `content` is its text

### Requirement: Draft preparation tools
`create_draft` SHALL take `{ accountId, mode, source?, from?, to, cc, bcc, subject, body, format? }` with `mode` `new`, `reply`, `reply_all` or `forward`; `source` (`canonicalMessageId`, `conversationId`) SHALL be required except for `new`. `from` SHALL select an identity by address and default to the account's primary address. `update_draft` SHALL take `{ accountId, draftId, version }` plus any of those fields and keep the others. Both SHALL return the draft and SHALL NOT send it.

#### Scenario: Draft a reply for review
- **WHEN** an agent creates a reply draft to a message from the alias identity
- **THEN** the draft is stored editable with mode `reply`, the source and the alias address, and nothing is sent

#### Scenario: Stale version
- **WHEN** an agent updates a draft with an old version
- **THEN** the call fails with the draft conflict and the draft is unchanged

### Requirement: No tool sends a draft
No page or remote tool SHALL send, claim or recover a draft. Sending a draft SHALL remain the person's action in the compose form.

#### Scenario: Agent wants to send its draft
- **WHEN** an agent lists tools
- **THEN** no tool sends a draft

## MODIFIED Requirements

### Requirement: The person controls which tools are offered
The UI SHALL list every tool with its effect (`read`, `write`, `write · destructive` for `delete_folder`, `write · undoable` for actions and undo, `write · proposal`, `write · draft`, `irreversible` for `send_message`) under Settings › Assistant control, and let the person expose or hide each one. A change SHALL re-register the tools immediately with only the exposed ones, and the hidden set SHALL persist in the browser's local storage.

#### Scenario: Hide send_message
- **WHEN** a person hides `send_message`
- **THEN** the page re-registers its tools without `send_message`, and it stays hidden after a reload

### Requirement: Fixed tool set with proposal preparation
The system SHALL define exactly twenty-six page tools: the nineteen earlier tools plus `list_identities`, `list_signatures`, `list_drafts`, `read_draft`, `read_attachment`, `create_draft` and `update_draft`. Inspection tools SHALL have `readOnlyHint: true`, all others `readOnlyHint: false`, and all `untrustedContentHint: true`. No tool SHALL approve, apply or decline a proposal.

#### Scenario: Agent inspects available tools
- **WHEN** an agent lists the tools of an open Postreeve page with nothing hidden
- **THEN** it sees the nineteen earlier tools and the seven identity, draft and attachment tools, and none that approves, applies or declines a proposal
