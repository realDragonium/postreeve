# Proposal

## Why

The owner runs mail for several of their own domains, often on cPanel, older Dovecot or Exchange hosts that do not advertise IMAP SPECIAL-USE flags, and often with catch-all delivery. Today:

- Archive, Sent, Trash, Junk and Drafts are found only through SPECIAL-USE. Without the flags, Archive and Spam are disabled in the reader, sent copies fail with "no discoverable special-use Sent mailbox", provider draft mirrors fail, and the Unified view misses these folders.
- A reply to mail delivered to `anything@example.com` through a catch-all leaves from the primary address unless that exact address was registered first, which exposes the primary address.
- Gmail Send mail as addresses must be retyped by hand as identities, although Postreeve already reads that list to validate sends.

## What Changes

- IMAP special folders resolve per role with the precedence: owner override, then SPECIAL-USE flag, then a name heuristic over common folder names in several languages (top level or directly under INBOX). Each folder reports how its role was found (`specialUseSource`).
- Per-account folder overrides at `GET`/`PUT /api/accounts/<id>/folder-mappings` (IMAP only), stored in a new `folder_mappings` table and edited in the Manage folders sheet. A role can be set to a folder, to None, or left Automatic.
- The IMAP provider's own Sent, Drafts and Trash lookups use the same resolution, so sent copies, draft mirrors and Trash work on hosts without SPECIAL-USE.
- Wildcard identities `*@domain` on IMAP accounts. An address on that domain counts as an identity of the account: replies to mail delivered there default From to that exact address, drafts may send from it, and the wildcard's signature applies to it. Sending from an address on an undeclared domain stays refused.
- Compose offers **Add as identity** when the source was delivered to an address that is not one of the account's identities.
- `POST /api/accounts/<id>/identities/import` imports Gmail's verified Send mail as addresses as identities; the identity sheet offers it as a refreshable button, and connecting a Gmail account imports them once.

## Capabilities

### Modified Capabilities

- `mailbox/folders`: name-based detection, owner overrides, mapping editor in the Manage folders sheet.
- `compose/identities`: wildcard identities, signatures for wildcard-covered addresses, Gmail Send mail as import, Add as identity from compose.
- `compose/drafts`: reply From defaults to the exact delivered address when a wildcard identity covers it.

## Impact

`src/shared/special-folders.ts` (new), `src/shared/identities.ts`, `src/shared/contracts.ts`, `src/server/db/folder-mappings.ts` (new table and migration), `src/server/db/store.ts`, `src/server/contacts/correspondents.ts` (wildcard-aware own-address test), `src/server/mail/imap.ts`, `src/server/mail/gmail.ts`, `src/server/mail/provider.ts`, `src/server/core/postreeve.ts`, `src/server/api.ts`, `src/web/api.ts`, `src/web/panels.tsx`, FEATURES.md. No App.tsx or Reader.tsx changes are needed: the reader and Unified view read `specialUse` from the folder list, which now includes resolved roles.
