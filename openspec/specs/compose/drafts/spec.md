# Drafts Specification

## Purpose
Covers server-side drafts: their versioned create, list, read, update and delete operations, autosave from the web compose form, compose modes, and the idempotent delivery state that governs sending a draft, recovering from interrupted or uncertain sends, and migrating old browser-local drafts. Provider Drafts-folder copies are specified in compose/provider-drafts; uploaded files in compose/draft-files; dispatch, receipts and failure classes in compose/sending; account removal in accounts/imap-smtp-accounts.

## Requirements

### Requirement: Draft content and scope
The system SHALL store each draft for one account as `{ id, accountId, mode, to, cc, bcc, subject, body, identity, source?, attachments, delivery, mirror, createdAt, updatedAt, version }` with `mode` `new`, `reply`, `reply_all` or `forward`. Each recipient field SHALL be raw text kept exactly as typed or a list of up to 100 `{ name, address }`. `subject` SHALL be at most 998 and `body` at most 2,000,000 characters. A draft SHALL be visible only under its own account.

#### Scenario: Unfinished recipient text survives
- **WHEN** a draft is saved with `to` set to `  alice@  `
- **THEN** reading it back returns `to` as `  alice@  ` unchanged

#### Scenario: Draft requested under another account
- **WHEN** a client reads a draft ID under an account that does not own it
- **THEN** the response is 404 `{ error: "Draft not found", code: "draft_not_found" }`

### Requirement: Creating a draft is idempotent per client identity
The system SHALL create a draft at `POST /api/accounts/<accountId>/drafts`, answering 201 with the draft at version 1 and delivery `editable`. An optional `clientId` SHALL become the draft ID. Repeating a create with an existing `clientId` SHALL return the stored draft unchanged, and a `clientId` of a deleted draft SHALL answer 410 `{ error: "Draft was deleted", code: "draft_deleted" }`.

#### Scenario: Lost create response retried
- **WHEN** a create succeeds, its response is lost and the client repeats it with the same `clientId` and newer content
- **THEN** the response returns the originally stored content at version 1, and only one draft exists

#### Scenario: Recreating a deleted draft
- **WHEN** a client creates a draft with the `clientId` of a draft that was deleted
- **THEN** the response is 410 with code `draft_deleted` and no draft is created

#### Scenario: Client ID of another account
- **WHEN** a client creates a draft with a `clientId` already used by another account
- **THEN** the response is 400 and nothing is created

### Requirement: Listing and reading drafts
The system SHALL list an account's drafts at `GET /api/accounts/<accountId>/drafts`, newest `updatedAt` first, excluding drafts whose delivery is `sent`. `GET /api/accounts/<accountId>/drafts/<draftId>` SHALL return a draft in any delivery state, or 404 `draft_not_found`. Both SHALL first reconcile provider copies as specified in compose/provider-drafts.

#### Scenario: Sent draft leaves the list
- **WHEN** a draft has been sent
- **THEN** it no longer appears in the draft list but can still be read by its ID with its receipt

### Requirement: Updates use optimistic versions
The system SHALL update a draft at `PUT /api/accounts/<accountId>/drafts/<draftId>` with its complete content and the `version` last seen, returning it with the version increased by one. A stale version SHALL answer 409 `{ error: "Draft version conflict", code: "draft_conflict" }` without change. Only `editable` and `failed` drafts SHALL be updatable, and an update SHALL return a `failed` draft to `editable`. Every delivery transition SHALL also increase the version.

#### Scenario: Two clients edit the same version
- **WHEN** two clients update version 3 of a draft and the first succeeds
- **THEN** the second receives 409 `draft_conflict` and the first client's content is kept

#### Scenario: Editing after a failed send
- **WHEN** a client updates a `failed` draft with its current version
- **THEN** the draft holds the new content and its delivery is `editable`

#### Scenario: Editing an uncertain draft
- **WHEN** a client updates an `uncertain` draft with its current version
- **THEN** the response is 409 `draft_conflict` with `Draft cannot be updated while delivery is uncertain`

### Requirement: Deleting a draft
The system SHALL delete a draft at `DELETE /api/accounts/<accountId>/drafts/<draftId>` with `{ version }`, answering `{ ok: true }`, removing its stored files and retiring its ID. A stale version, or a draft whose delivery is `sending`, SHALL answer 409 `draft_conflict`. The provider copy SHALL be removed first; when that fails the request SHALL fail with 400 and the draft SHALL remain.

#### Scenario: Delete during delivery
- **WHEN** a client deletes a draft while its delivery is `sending`
- **THEN** the response is 409 `Draft cannot be removed while delivery is sending` and the draft remains

#### Scenario: Provider copy cannot be removed
- **WHEN** a client deletes a draft and the provider refuses to remove its Drafts-folder copy
- **THEN** the request fails, the draft keeps its content and its mirror reports `failed`

### Requirement: Compose autosaves to the server
The web compose form SHALL save to the server 700 ms after the last change when its content differs from the saved draft, creating the draft on first save with a client-generated ID, and SHALL run saves one at a time so an older save cannot replace newer content. It SHALL offer **Save draft**, save unsaved changes on close, and show whether the draft is saving, saved or unsaved. Reopening a draft without editing it SHALL NOT save it.

#### Scenario: Typing pauses
- **WHEN** a user types a subject and pauses
- **THEN** the draft is saved to the server and the footer shows `Draft saved <time>`

#### Scenario: Another client changed the draft
- **WHEN** a save fails with 409 because another client saved a newer version
- **THEN** the form shows `Draft not saved` with the reason and keeps the typed content

#### Scenario: Body-only edit of a structured draft
- **WHEN** a user changes only the body of a draft whose recipients are stored as structured lists
- **THEN** the saved recipients remain the same structured lists

### Requirement: Compose modes start from the source message
The web interface SHALL open reply, reply-all and forward forms from a message and store the mode and source with the draft. A reply SHALL address the source's Reply-To, or else its From, without the account's own addresses, its primary address and identities, and quote the source; reply-all SHALL also copy the source's other To and Cc addresses to Cc; a forward SHALL start without recipients, with a `Fwd: ` subject and the forwarded message in the body.

#### Scenario: Reply-all recipients
- **WHEN** a user replies all to a message from Alice to the user and Bob, with Carol in Cc
- **THEN** To holds Alice and Cc holds Bob and Carol, without the user's own address

#### Scenario: Conversation draft without its source
- **WHEN** a user opens a reply draft that has no source
- **THEN** sending is unavailable, **Convert to a new message** changes its mode to `new`, and sending it unconverted through the API answers 400 `Conversation draft source was not found`

### Requirement: Sending a draft is validated before dispatch
The system SHALL send a draft at `POST /api/accounts/<accountId>/drafts/<draftId>/send` with `{ version }`, answering with the send receipt. Before dispatch it SHALL refuse, leaving the draft unchanged: a stale version or a draft in `sending` or `uncertain` with 409 `draft_conflict`, and with 400 a file without stored content, an identity the account does not have, raw recipients that do not split on commas into valid addresses, an empty To or body, or an invalid source.

#### Scenario: Unparseable raw recipients
- **WHEN** a draft whose `to` is `alice@` is sent
- **THEN** the response is 400, nothing is dispatched and the stored `to` is still `alice@`

#### Scenario: Send already in progress
- **WHEN** a client sends a draft whose delivery is `sending`
- **THEN** the response is 409 `draft_conflict` and nothing is dispatched

#### Scenario: Identity that is not stored
- **WHEN** a client sends a draft whose identity address is `other@example.test` and the account has no such identity
- **THEN** the response is 400 `Draft identity does not belong to the selected account` and nothing is dispatched

### Requirement: Compose From follows the receiving identity
For reply, reply-all and forward forms, From SHALL default to the first of the source's Delivered-To, To and Cc addresses that is the account's address or one of its identities, or else the primary address. The compose form SHALL disable sending while its From address is neither.

#### Scenario: Reply to mail delivered to an alias
- **WHEN** a user replies to a message delivered to their identity `sales@example.test` through a catch-all
- **THEN** From is preselected as `sales@example.test` and `sales@example.test` is not a recipient

#### Scenario: Saved draft from a removed identity
- **WHEN** a user opens a draft whose identity was removed from the account
- **THEN** the From selector shows that address and Send is disabled until another identity is chosen

### Requirement: Sending a draft claims it exactly once
After validation the system SHALL atomically move the draft to `sending` with `claimedAt` and a new version, so that of concurrent send, update and delete requests for one version exactly one message is dispatched. The web compose form SHALL save pending changes before sending and send the saved version.

#### Scenario: Concurrent sends
- **WHEN** two send requests for the same draft version arrive together
- **THEN** one message is dispatched and the other request receives 409 `draft_conflict`

#### Scenario: Edit lands before the claim
- **WHEN** another client updates the draft after a send request was validated but before it was claimed
- **THEN** the send answers 409 `draft_conflict` and nothing is dispatched

### Requirement: Delivery outcomes are recorded on the draft
After dispatch the system SHALL record `sent` with `settledAt` and the receipt when any recipient accepted; `failed` with `failedAt`, the error and any receipt when none accepted or the failure was pre-dispatch; and `uncertain` with `failedAt` and the error for any other failure. A `failed` draft SHALL be retryable by sending or editing its current version. When accepted delivery cannot be recorded, the response SHALL carry the receipt and a warning, and the draft SHALL become `uncertain`.

#### Scenario: Every recipient refused
- **WHEN** a draft is sent and the provider accepts no recipient
- **THEN** the draft is `failed` with `No recipients were accepted for delivery` and the receipt, and the web form says its draft and files are retained for retry

#### Scenario: Some recipients refused
- **WHEN** a draft is sent and the provider accepts one of two recipients
- **THEN** the draft is `sent` and its receipt lists the refused recipient in `rejected`

#### Scenario: Ambiguous provider failure
- **WHEN** the provider connection fails after submission began
- **THEN** the request fails and the draft is `uncertain` with the provider's error

#### Scenario: Receipt cannot be stored
- **WHEN** delivery is accepted but the sent state cannot be stored
- **THEN** the response carries the receipt with a warning and the draft is `uncertain` with `Delivery was accepted, but its receipt could not be stored`

### Requirement: Sent drafts settle and replay their receipt
Sending a draft whose delivery is `sent` SHALL return its stored receipt, whatever version is supplied, without dispatching again, including after a restart. A sent draft SHALL be readable by ID with its receipt and files, SHALL NOT be updatable (409 `draft_conflict`), and SHALL be deletable with its current version.

#### Scenario: Retry after a lost send response
- **WHEN** a client repeats the send request of a draft that was already sent
- **THEN** the response is the original receipt and no second message is dispatched

### Requirement: Uncertain sends require an explicit recovery copy
The system MUST NOT retry an `uncertain` draft automatically. `POST /api/accounts/<accountId>/drafts/<draftId>/copy` with `{ version }` SHALL answer 201 with a new `editable` draft at version 1 under a new ID, holding the same content and its own copies of the files, and SHALL increase the original's version while it stays `uncertain`. Only an `uncertain` draft at its current version SHALL be copied; otherwise the response SHALL be 409 `draft_conflict`.

#### Scenario: Uncertain draft in compose
- **WHEN** a user opens an uncertain draft
- **THEN** the form is locked, warns `Delivery is uncertain. This message may already have been sent. Check your sent mail before sending a copy.` and offers **Create a copy to review**

#### Scenario: Reviewing an uncertain send
- **WHEN** a user selects **Create a copy to review**
- **THEN** an editable copy opens with the same text and files, nothing is sent, and the original remains uncertain

#### Scenario: Copy with a stale version
- **WHEN** a client copies an uncertain draft using the version from before a previous copy
- **THEN** the response is 409 `draft_conflict`

### Requirement: Interrupted sends become uncertain at startup
On startup the server SHALL mark every draft left in `sending` by an earlier server process as `uncertain` with `Delivery was interrupted before its outcome could be recorded`, increase its version, and SHALL NOT dispatch it again. Sends in progress in the running process SHALL NOT be changed.

#### Scenario: Crash during delivery
- **WHEN** the server stops while a draft is `sending` and is started again
- **THEN** the draft is `uncertain` with the interruption error and sending it answers 409

### Requirement: Browser-local drafts migrate once
Once accounts have loaded, the web interface SHALL create each draft from the browser storage key `postreeve.local-drafts.v1` on the server with client ID `local-<hex SHA-256 of accountId, NUL, local ID>`, keeping its content, its From address as identity and its attachment metadata without content. Malformed records and records answered 410 SHALL be dropped; others that fail SHALL be kept and retried. A repeated migration MUST NOT overwrite server content.

#### Scenario: Legacy record mapping
- **WHEN** a local draft has mode `draft` and an invalid From value
- **THEN** it is created with mode `new` and the account's own identity

#### Scenario: Draft for an account not yet connected
- **WHEN** a local draft names an account that is not configured
- **THEN** it stays in browser storage and `postreeve.local-drafts.migrated.v2` is not marked complete until it has migrated

#### Scenario: Migration repeated
- **WHEN** a draft was migrated and edited on the server, and the browser repeats the migration
- **THEN** the server keeps the edited content

### Requirement: Account removal respects active delivery
Account removal SHALL wait for running draft operations of that account and SHALL be refused with 409 `account_conflict` while one of its drafts is `sending`. When removal completes first, a pending send of that account's draft SHALL fail with 404 `draft_not_found` without dispatching. Removal SHALL delete the account's drafts, files and retired draft IDs locally and leave provider draft copies in place.

#### Scenario: Removal during a send
- **WHEN** a user removes an account while one of its drafts is being delivered
- **THEN** removal answers 409 `account_conflict`, and the draft's eventual outcome is recorded normally

#### Scenario: Removal wins before the send claim
- **WHEN** an account is removed while a send request for its draft is still validating
- **THEN** the send fails with `draft_not_found` and no message is dispatched
