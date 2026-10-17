# Spec Delta

## MODIFIED Requirements

### Requirement: IMAP folders and special-use detection
For an IMAP account the system SHALL list every selectable mailbox (omitting `\Noselect`) with counts from the server's message and unseen status. The path `INBOX` in any case SHALL have `specialUse` `inbox`. The roles `sent`, `drafts`, `trash`, `junk` and `archive` SHALL be resolved per role in this order: the account's folder override for the role; otherwise every folder carrying the matching SPECIAL-USE attribute (`\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive` or `\All`); otherwise, only when no folder carries that attribute, the first folder without a role whose name matches a known name for the role (for example `Sent`, `Sent Items`, `Verzonden`, `Drafts`, `Trash`, `Deleted Items`, `Prullenbak`, `Junk`, `Spam`, `Archive`), compared case-insensitively, where the folder is at the top level or directly under INBOX. Earlier names in a role's list SHALL win over later ones, then listing order. Every other folder SHALL have `specialUse` `null`. Each IMAP folder SHALL report `specialUseSource`: `override`, `special-use` (also for INBOX), `name`, or `null` when it has no role. The IMAP provider SHALL use the same resolution to find the Sent folder for sent copies, the Drafts folder for provider drafts and the Trash folder for Trash.

#### Scenario: Special-use attributes classify folders
- **WHEN** an IMAP server lists `INBOX`, `Sent Items` marked `\Sent` and `Projects` with no attribute
- **THEN** they are reported with `specialUse` `inbox`, `sent` and `null`

#### Scenario: Non-selectable parent is hidden
- **WHEN** an IMAP server lists a `\Noselect` parent mailbox above selectable children
- **THEN** the parent is absent from the list and its children are present

#### Scenario: Name detection without SPECIAL-USE
- **WHEN** a cPanel server lists `INBOX`, `INBOX.Sent`, `INBOX.Trash`, `INBOX.spam` and `INBOX.Archive` without attributes
- **THEN** they are reported as `inbox`, `sent`, `trash`, `junk` and `archive`, the last four with `specialUseSource` `name`

#### Scenario: Name alone does not make a special folder
- **WHEN** an IMAP mailbox is named `Trash` without attributes while `Deleted Items` carries `\Trash`
- **THEN** `Deleted Items` is listed with `specialUse` `trash` and `Trash` with `null`

#### Scenario: Nested user folder is not special by name
- **WHEN** a server lists `Projects/Archive` without attributes
- **THEN** it is listed with `specialUse` `null`

#### Scenario: Sent copy without SPECIAL-USE
- **WHEN** an IMAP account whose server lists `Verzonden` without attributes sends a message with sent copies enabled
- **THEN** the copy is appended to `Verzonden`

### Requirement: Manage folders sheet
The web interface SHALL offer **Manage folders** for each account, listing every folder with its message count and kind. Folders with a `specialUse` SHALL be marked Protected and offer no rename or delete. Custom folders SHALL offer Rename and Delete; for IMAP accounts Delete SHALL be disabled while the folder's `total` is above zero. Delete SHALL ask for confirmation, and a failed operation SHALL show the provider's error in the sheet.

#### Scenario: Protected folder
- **WHEN** a person opens Manage folders for an account
- **THEN** Inbox and other special folders, including ones found by name or mapped by the owner, show Protected without Rename or Delete

#### Scenario: Non-empty IMAP folder cannot be deleted from the sheet
- **WHEN** an IMAP custom folder has a `total` of 4
- **THEN** its Delete button is disabled with a hint to move every message out first

## ADDED Requirements

### Requirement: Special-folder overrides are stored per account
The system SHALL return an IMAP account's overrides at `GET /api/accounts/<accountId>/folder-mappings` as an object whose optional keys `archive`, `sent`, `drafts`, `trash` and `junk` hold a folder path or `null` (None); a missing key means Automatic. `PUT` with that object SHALL replace the overrides and answer with the updated folder list. Overrides SHALL be removed with their account.

#### Scenario: Map Sent manually
- **WHEN** the owner puts `{ sent: "Outbox copies" }` for an IMAP account whose server marks `Sent` as `\Sent`
- **THEN** the returned list has `Outbox copies` as `sent` with source `override` and `Sent` as `null`, and later sent copies go to `Outbox copies`

### Requirement: Special-folder overrides are validated
A `PUT` path SHALL name a selectable folder currently listed for the account, SHALL NOT be `INBOX`, and SHALL NOT be used for two roles; otherwise the request SHALL answer 400 and change nothing. A Gmail account SHALL answer 400 `Gmail folders are fixed system labels`.

#### Scenario: Same folder for two roles
- **WHEN** a client puts `{ sent: "Mail", archive: "Mail" }`
- **THEN** the response is 400 and the stored overrides are unchanged

#### Scenario: Gmail account
- **WHEN** a client puts overrides for a Gmail account
- **THEN** the response is 400

### Requirement: Overrides take precedence
An override SHALL take its folder away from any other role. None SHALL leave the role without a folder even when a folder carries the matching SPECIAL-USE attribute or a matching name. An override whose folder no longer exists SHALL be ignored, and the role SHALL resolve automatically.

#### Scenario: Disable a role
- **WHEN** the owner puts `{ junk: null }` for an account with a folder named `Spam`
- **THEN** no folder of the account has `specialUse` `junk`

#### Scenario: Mapped folder was removed
- **WHEN** the folder an override names is deleted in another client
- **THEN** the role resolves from SPECIAL-USE or names again

### Requirement: Special folders in the Manage folders sheet
For an IMAP account the Manage folders sheet SHALL offer a Special folders section with one selector each for Archive, Sent, Drafts, Trash and Spam, offering Automatic, None and every non-INBOX folder, and SHALL save them through the folder-mappings API, show any error and update the sidebar with the returned list. Each folder row SHALL show how a special role was found when it came from a name or override.

#### Scenario: Map Archive from the sheet
- **WHEN** the owner chooses `Old mail` for Archive and saves
- **THEN** the reader's Archive button moves messages to `Old mail`
