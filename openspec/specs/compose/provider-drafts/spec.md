# Provider Drafts Specification

## Purpose
Covers mirroring each Postreeve draft into the account's Gmail drafts or IMAP Drafts mailbox: what the provider copy contains, how its status is reported, how copies are reconciled, repaired and cleaned up, and which provider drafts Postreeve may touch. The Postreeve draft stays authoritative; its lifecycle and versions are specified in compose/drafts, its files in compose/draft-files.

## Requirements

### Requirement: Saved drafts are mirrored to the provider
After a draft is created, updated, given a file or copied for recovery, the system SHALL write its current version to the provider: as a Gmail draft for Gmail accounts, or as a message flagged `\Draft` appended to the special-use Drafts mailbox for IMAP accounts. A mirror failure MUST NOT fail the save; the saved draft SHALL be returned with mirror status `failed`.

#### Scenario: Provider unreachable while saving
- **WHEN** a user saves a draft while the provider cannot be reached
- **THEN** the draft is saved in Postreeve and its mirror status is `failed` with the provider error

#### Scenario: IMAP account without a Drafts mailbox
- **WHEN** a draft is saved for an IMAP account whose server marks no selectable mailbox as `\Drafts`
- **THEN** the draft is saved and its mirror error is `This account has no discoverable special-use Drafts mailbox`

### Requirement: Mirror status is reported with every draft
Every draft SHALL carry `mirror` with `status` `pending`, `synced` or `failed`, and where known `mirroredVersion` and `ref` (`{ kind: "gmail", draftId }` or `{ kind: "imap", mailbox, uidValidity, uid }`); `failed` SHALL include `error`. `synced` SHALL mean the provider holds the draft's current version under `ref`. The Drafts list and the compose form SHALL show whether a draft is mirrored, awaiting synchronization or needs repair.

#### Scenario: Successful mirror
- **WHEN** a draft at version 4 has been written to the provider
- **THEN** its mirror is `synced` with `mirroredVersion` 4 and the provider reference, and the Drafts list labels it `mirrored to provider`

#### Scenario: Failed mirror in compose
- **WHEN** a user opens a draft whose mirror failed
- **THEN** the form shows `Saved in Postreeve. Provider mirror needs repair: <error>`

### Requirement: Provider copies carry the draft and its ownership markers
A provider copy SHALL be a MIME message with the draft identity as From, its To, Cc and Bcc (Bcc retained), subject, body and stored files, dated at `updatedAt`, carrying the headers `X-Postreeve-Draft-Tenant-ID`, `X-Postreeve-Draft-Account-ID`, `X-Postreeve-Draft-ID`, `X-Postreeve-Draft-Version`, `X-Postreeve-Draft-Mode` and, for conversation drafts, `X-Postreeve-Draft-Source`. Raw recipient text SHALL be written even when it is not a valid address.

#### Scenario: Unfinished recipient text
- **WHEN** a draft with `to` set to `bob@` is mirrored
- **THEN** the provider copy is written with that text in its To header

### Requirement: Drafts must fit the message limit
The system SHALL refuse to create, update or add a file to a draft whose provider copy would exceed `POSTREEVE_MAX_MESSAGE_BYTES`, answering 400 and leaving the stored draft unchanged.

#### Scenario: Draft too large for the provider copy
- **WHEN** an update would make the encoded draft exceed the message limit
- **THEN** the update answers 400 and the stored draft keeps its previous version

### Requirement: Postreeve only touches drafts it owns
The system SHALL read, replace or delete only provider drafts whose markers name the same tenant, account and draft ID. It MUST NOT import, change or delete any other provider draft, including drafts written in the provider's own client and drafts of another Postreeve account sharing the mailbox. A copy that keeps the draft's markers but was changed outside Postreeve SHALL be overwritten without changing the Postreeve draft's content or version.

#### Scenario: Mailbox reconnected as a new account
- **WHEN** an account with mirrored drafts is removed and the same mailbox is added again as a new account
- **THEN** the new account lists no drafts and the old provider copies are left untouched

#### Scenario: Provider copy changed outside Postreeve
- **WHEN** a mirrored copy's version marker is changed at the provider and the user then lists drafts in Postreeve
- **THEN** the provider copy is rewritten with the Postreeve content and the Postreeve version does not change

### Requirement: One provider copy per draft
After each successful write exactly one active provider copy SHALL exist for the draft; stale versions and duplicates from earlier ambiguous writes SHALL be removed, or the mirror SHALL fail. A Gmail write whose response was lost SHALL adopt the copy carrying the same version marker instead of writing another; a Gmail update answered 404 SHALL create a new copy, and a Gmail delete answered 404 SHALL count as removed.

#### Scenario: Lost Gmail create response
- **WHEN** Gmail stores a new draft but the response is lost
- **THEN** the retry finds the stored copy by its markers and no duplicate remains

#### Scenario: IMAP update
- **WHEN** an IMAP draft is updated from version 2 to version 3
- **THEN** the Drafts mailbox holds one active copy, marked version 3

### Requirement: IMAP servers without UIDPLUS
Without UIDPLUS the system SHALL find the appended copy by its version marker and retire stale copies by flagging them `\Deleted` without expunging, so other messages flagged `\Deleted` are not expunged, and SHALL ignore flagged copies afterwards. With UIDPLUS it SHALL remove stale copies by UID and verify their removal. When the server does not confirm the change, the mirror SHALL fail.

#### Scenario: Update without UIDPLUS
- **WHEN** a draft is updated on a server without UIDPLUS
- **THEN** the previous copy is flagged `\Deleted`, stays in the mailbox and is no longer treated as the draft's copy

#### Scenario: Server keeps a stale copy
- **WHEN** the server does not confirm removing or flagging a stale copy
- **THEN** the mirror fails with `IMAP stored the current draft but refused to remove stale copies`

### Requirement: Reconciliation when drafts are read
Listing, reading and sending drafts SHALL first retry pending cleanups of deleted drafts, then rewrite every draft that is neither `sent` nor `sending` and lacks exactly one provider copy at its current version under its recorded `ref`, at most 100 repairs per request. When the provider's drafts cannot be listed, the drafts SHALL still be returned without repair.

#### Scenario: Provider copy deleted outside Postreeve
- **WHEN** a mirrored draft's provider copy is deleted in the provider's client and the user opens the Drafts list
- **THEN** the copy is written again and the draft's mirror is `synced`

#### Scenario: Provider offline during listing
- **WHEN** the provider cannot list drafts
- **THEN** `GET /api/accounts/<accountId>/drafts` still returns the stored drafts

### Requirement: Provider draft listings are bounded
The system MUST NOT act on a partial listing of provider drafts. More than 1,000 `\Draft` messages in the IMAP Drafts mailbox, or more than 20 pages of 100 Gmail drafts, SHALL fail the listing, which skips reconciliation and fails provider writes for that account.

#### Scenario: Oversized IMAP Drafts mailbox
- **WHEN** the IMAP Drafts mailbox holds 1,001 messages flagged `\Draft`
- **THEN** listing drafts returns them without repair and saving a draft records a failed mirror

### Requirement: Provider copies are removed after send and delete
After a draft is sent the system SHALL remove its provider copy; when that fails, the send SHALL still succeed with a receipt warning, the mirror SHALL be `failed`, and removal SHALL be retried when the send request is repeated. Deleting a draft SHALL remove its provider copy first, and write it again if the local deletion then loses a race. Account removal SHALL leave provider copies in place.

#### Scenario: Cleanup fails after delivery
- **WHEN** a draft is sent and its Gmail copy cannot be deleted
- **THEN** the receipt's `warning` reads `Message delivery succeeded, but the provider draft could not be removed: <reason>` and the message is not sent again

### Requirement: Late provider writes never override newer state
When a provider write completes after the draft changed, the system SHALL rewrite the copy for the current version, or remove it when the draft was sent or deleted, and SHALL NOT replace a recorded reference with one from an older version. When removing the copy of a deleted draft fails, the system SHALL retry on later draft list and read requests and before answering 410 to a create reusing that draft ID.

#### Scenario: Older write completes last
- **WHEN** the provider write for version 2 finishes after version 3 was saved
- **THEN** the provider copy is rewritten as version 3 and the draft's mirror records version 3

#### Scenario: Write completes after deletion
- **WHEN** a provider write finishes after its draft was deleted
- **THEN** the written copy is removed, or its removal is retried on the next draft listing

### Requirement: Draft lifecycle operations are serialized per account
Within a server process, creating, updating, uploading to, deleting, copying, reconciling and post-send cleanup of drafts, and account removal, SHALL run one at a time per account, including across service instances that share the same database file. Account removal SHALL wait for an in-flight provider write of that account to finish.

#### Scenario: Removal during a mirror write
- **WHEN** an account is removed while a draft's provider write is in progress
- **THEN** removal completes only after that write finished, and the provider copy is left in place
