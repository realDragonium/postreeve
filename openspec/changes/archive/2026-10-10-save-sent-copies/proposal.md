# Proposal

## Why

Mail sent from an IMAP/SMTP account is lost from the user's sent history on providers that do not file SMTP submissions themselves (iCloud and most hosted IMAP). Postreeve never appends a sent copy, so the Sent folder stays empty for those accounts and replies never show up in Sent on other devices. Outgoing Message-IDs also end in `@postreeve.local`, which does not match the sender's domain and costs spam score.

## What Changes

- After an SMTP send that at least one recipient accepted, Postreeve appends the exact transmitted MIME, flagged `\Seen`, to the account's special-use Sent mailbox and indexes the stored copy so it appears in Sent and in its conversation immediately.
- A failed append never turns a delivered send into a failure: the receipt carries a warning, which a draft's stored receipt keeps visible.
- New per-account IMAP setting **Save a copy to Sent** (`saveSentCopy`). It defaults from the IMAP host: off for Gmail/Google Workspace and Outlook/Office 365, which file SMTP submissions themselves, on for every other host. The account sheet shows and edits it; accounts stored before this change use the host default.
- Every sent message, Gmail and SMTP, gets `Message-ID: <uuid@<sender domain>>` instead of `<uuid@postreeve.local>`.
- WebMCP: no tool changes. `send_message` sends through the same path and therefore also saves the copy; account settings remain UI-only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `compose/sending`: Message-ID form uses the sender's domain; new requirement for saving a sent copy to the IMAP Sent mailbox and its failure warning.
- `accounts/imap-smtp-accounts`: settings, add and update carry `saveSentCopy` with a host-derived default; the account sheet edits it.

## Impact

- `src/server/mail/sender.ts`, `smtp.ts`, `gmail.ts`, `outgoing-content.ts`: senders return the transmitted MIME with the receipt; shared Message-ID helper.
- `src/server/mail/imap.ts`, `provider.ts`: Sent-mailbox append returning the stored message summary.
- `src/server/core/postreeve.ts`: append and index after dispatch; settings round-trip.
- `src/server/security/credentials.ts`, `src/shared/contracts.ts`: optional `saveSentCopy` in stored SMTP settings and account contracts.
- `src/web/panels.tsx`: checkbox in the outgoing-mail section.
- Tests in `tests/support/test-mail.ts`, core, SMTP and IMAP compatibility suites. README and FEATURES.md rows.
- No database migration: the setting lives in the encrypted IMAP account settings and is optional there.
