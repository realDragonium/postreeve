# Draft Files Specification

## Purpose
Covers ordinary file attachments on outgoing mail: uploading files into a saved draft, storing and downloading them, removing them, keeping them through failed and uncertain sends, and the upload and message limits the compose form shows. Draft versions and delivery states are specified in compose/drafts; how files reach the provider in compose/sending and compose/provider-drafts; downloading attachments of received mail in mailbox/message-reading. Inline (CID) images are not supported.

## Requirements

### Requirement: Uploading a file into a saved draft
The system SHALL accept `POST /api/accounts/<accountId>/drafts/<draftId>/files` with the file's bytes as body and the header `X-Postreeve-File` holding URI-encoded JSON `{ id, version, name, type }`: a client-chosen UUID, the draft's current version, a name of 1 to 1,000 characters and a type of at most 255. It SHALL answer 200 with the draft at the next version and `{ id, name, type, size }` appended to `attachments`.

#### Scenario: First file
- **WHEN** a client uploads a 4-byte file to version 1 of a draft
- **THEN** the response is the draft at version 2 with one attachment of size 4 and the file's ID

### Requirement: Uploads to stale or locked drafts are refused
An upload naming a stale version, or to a draft whose delivery is not `editable` or `failed`, SHALL answer 409 `draft_conflict`, and a missing or malformed `X-Postreeve-File` header SHALL answer 400, without storing anything. An upload to a `failed` draft SHALL return its delivery to `editable`.

#### Scenario: Upload to an uncertain draft
- **WHEN** a client uploads a file to a draft whose delivery is `uncertain`
- **THEN** the response is 409 and nothing is stored

#### Scenario: Missing metadata header
- **WHEN** a client uploads without `X-Postreeve-File`
- **THEN** the response is 400 and the draft is unchanged

### Requirement: Uploaded names and types are made safe
The system SHALL remove control characters from an uploaded file name, using `attachment` when nothing remains, and SHALL store the media type in lowercase without parameters, or as `application/octet-stream` when it is not a valid `type/subtype`.

#### Scenario: Unknown media type
- **WHEN** a file is uploaded with an empty type
- **THEN** its stored type is `application/octet-stream`

### Requirement: Upload and message size limits
The system SHALL refuse a file larger than `POSTREEVE_MAX_UPLOAD_BYTES` (default 20,971,520 bytes), judged by a declared `Content-Length` or by the bytes actually received, with 413 `{ error: "File exceeds the <limit>-byte upload limit" }`. It SHALL refuse with 400 an upload after which the draft's encoded message would exceed `POSTREEVE_MAX_MESSAGE_BYTES`. A refused upload SHALL leave the draft and its files unchanged.

#### Scenario: Oversized file
- **WHEN** a client uploads 801 bytes with an upload limit of 800 bytes
- **THEN** the response is 413 and the draft has no new attachment

#### Scenario: Files fit individually but not together
- **WHEN** a second file fits the upload limit but the encoded message with both files exceeds the message limit
- **THEN** the upload is refused with an error naming the message limit and the draft keeps one file

### Requirement: Upload retries are idempotent
Repeating an upload with a file ID already stored on the draft, with the same name, type and bytes, SHALL return the current draft without adding another file, whatever version it names. Reusing a stored file ID with different content SHALL answer 409 `Upload identity already belongs to different file content`.

#### Scenario: Upload response lost
- **WHEN** an upload succeeds, its response is lost and the client repeats it with the same file ID
- **THEN** the draft holds the file once and the repeat does not change the version

### Requirement: File bytes are stored privately with their draft
The system SHALL store each file's bytes in its SQLite database, owned by exactly one draft of one account, and commit them together with the new draft version. Draft responses SHALL expose only the opaque file ID, name, type and size, never the content. Files SHALL survive a restart and be available to every client of the server.

#### Scenario: Reopening after restart
- **WHEN** the server restarts after a file was uploaded
- **THEN** reading the draft lists the same attachment and downloading it returns the uploaded bytes

### Requirement: Downloading a draft file
The system SHALL serve a stored file at `GET /api/accounts/<accountId>/drafts/<draftId>/files/<fileId>` in any delivery state, with its media type as `Content-Type`, `Content-Disposition: attachment` with the file name, `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. An unknown draft or file SHALL answer 404 `draft_not_found`; a file ID that is not a UUID SHALL answer 400.

#### Scenario: File of a sent draft
- **WHEN** a client downloads a file of a draft that has been sent
- **THEN** the response contains the file's bytes

#### Scenario: File of another draft
- **WHEN** a client requests a file ID under a draft that does not own it
- **THEN** the response is 404 `draft_not_found`

### Requirement: Removing files
The system SHALL remove a file when the draft is updated with an `attachments` list that no longer contains it, deleting its bytes in the same transaction. Every attachment with an ID in an update MUST name a file stored for that draft with matching name, type and size, at most once; otherwise the update SHALL be refused with 400 `Draft file reference is invalid or belongs to another draft`. Deleting a draft or its account SHALL delete its files.

#### Scenario: User removes a file
- **WHEN** a user removes a file in compose and the draft saves
- **THEN** the file is no longer listed and its download answers 404

#### Scenario: Borrowing another draft's file
- **WHEN** a client updates a draft with an attachment ID that belongs to a different draft
- **THEN** the update is refused with 400 and nothing changes

### Requirement: Stored files are sent as attachments
When a draft is sent, the system SHALL attach every stored file to the outgoing message as a base64-encoded attachment with its name and media type, through Gmail and SMTP alike, and the provider draft copy SHALL carry the same files.

#### Scenario: Binary file delivered
- **WHEN** a draft with a binary file is sent
- **THEN** the delivered message contains an attachment with the same name, type and bytes

### Requirement: Files survive failed and uncertain sends
A draft whose send ends `failed` or `uncertain` SHALL keep its files, and a later send of a `failed` draft SHALL attach the same bytes. A recovery copy SHALL receive its own copies of the files, unaffected by deleting the original. A sent draft SHALL keep its files with its receipt until the draft or its account is removed.

#### Scenario: Recovery copy after deleting the original
- **WHEN** an uncertain draft with a file is copied for recovery and the original is then deleted
- **THEN** the copy's file still downloads and is attached when the copy is sent

### Requirement: Migrated drafts show missing file content
An attachment without an ID, as carried by drafts migrated from browser storage, SHALL be shown in compose as missing its content. Sending such a draft SHALL be refused with 400 `Some draft files have no stored content; remove or attach them again before sending`, and the compose form SHALL disable sending until the file is removed or attached again.

#### Scenario: Opening a migrated draft with a file
- **WHEN** a user opens a migrated draft that lists a file without content
- **THEN** the file is marked `Content missing; attach again` and **Send message** is disabled

### Requirement: Compose upload flow
The compose form SHALL save the draft before uploading, upload selected files one at a time and refuse a file over the upload limit before sending it. A failed upload SHALL stay listed with **Retry upload** and **Remove pending file**, and sending and closing SHALL be blocked until each pending file is retried or removed. When another client changed the draft during a pending upload, the form SHALL report the conflict rather than adopt that content.

#### Scenario: Upload fails offline
- **WHEN** a selected file fails to upload because the server is unreachable
- **THEN** the file stays listed with **Retry upload**, the typed content is kept, and closing shows `Retry or remove the files that have not uploaded before closing this draft`

### Requirement: Outgoing mail limits are published
The system SHALL answer `GET /api/outgoing-mail-limits` with `{ maxUploadBytes, maxMessageBytes }`, and the compose form SHALL show both limits. Both settings MUST be positive integers, otherwise the server SHALL refuse to start. They SHALL be independent of `POSTREEVE_MAX_ATTACHMENT_BYTES`, which limits downloads of received attachments.

#### Scenario: Configured limits
- **WHEN** the server runs with `POSTREEVE_MAX_UPLOAD_BYTES=1024` and `POSTREEVE_MAX_MESSAGE_BYTES=12000`
- **THEN** the endpoint returns those values and the compose form shows `Up to 1 KiB per file; 12,000 bytes per encoded message.`
