# Design

## Context

`SmtpMailSender.send` builds the MIME with `composeMime` and hands it to nodemailer as `raw`; the bytes never leave the sender. `ImapMailProvider` already appends Postreeve drafts to the special-use Drafts mailbox (`#replaceDraft`) and finds special-use mailboxes with `specialUseFor`. Synchronization indexes every selectable mailbox and `SynchronizationStore.observe` indexes provider summaries outside a sync run. A conversation send is recorded under its Message-ID before anything is observed, and conversations/conversation-threading already keeps such a message in place when it is later observed.

## Goals / Non-Goals

**Goals:** save the exact transmitted bytes; never weaken the pre-dispatch/uncertain classification of sends; no database migration.

**Non-Goals:** detecting server-side auto-save at runtime; deduplicating a copy the provider also filed; saving copies for Gmail; changing provider-draft Message-IDs (`postreeve-draft-…@postreeve.local`), which never leave the Drafts mailbox as sent mail.

## Decisions

- **Senders return the MIME with the receipt.** `MailSender.send` returns `SentMessage { receipt, mime: Buffer }`. The core owns the follow-up (append, index, warning) because it already owns receipts, warnings and draft settlement. Alternative: inject an append callback into `SmtpMailSender` — rejected, because the sender would then need the store to index the copy and to build warnings. Gmail returns its MIME too so the interface stays uniform; the core ignores it.
- **Append lives on the provider as an optional `appendSentMessage`.** `MailProvider` gains `appendSentMessage?(accountId, mime, sentAt): Promise<ProviderMessageSummary | null>`, implemented only by `ImapMailProvider`, mirroring the existing optional `synchronization`. It finds the Sent mailbox with `specialUseFor(...) === "sent"` (skipping `\Noselect`, like Drafts), appends with `[\Seen]` and the send time as internal date, and, when the server reports UIDPLUS `uid`/`uidValidity`, opens the mailbox read-only and returns the summary through the existing `#fetchSummaries`. Without a UID it returns `null` and synchronization indexes the copy later.
- **Order in the core.** `#dispatchMessageSend` records the conversation send first, then appends and observes the returned summary with `store.synchronization.observe`. Recording first means the observation reconciles into the recorded canonical message by Message-ID rather than creating a new one. All append/observe errors become the receipt warning; because the draft is settled with the returned receipt, the warning is stored on the draft.
- **Setting stored with the encrypted SMTP settings.** `smtp.saveSentCopy` is optional in `smtpCredentialsSchema`; the effective value is `smtp.saveSentCopy ?? defaultSaveSentCopy(imap.host)`. This avoids a migration and makes accounts stored earlier fall back to the host default. Alternative: an `accounts` column — rejected as a migration for one IMAP-only flag that is read only together with the SMTP settings. `defaultSaveSentCopy` lives in `src/shared` so the account sheet uses the same rule.
- **Message-ID helper.** `outgoingMessageId(fromAddress)` in `outgoing-content.ts` returns `<uuid@domain>` with `domainToASCII(domain.toLowerCase())`, falling back to `localhost` only if conversion yields an empty string (not reachable for validated addresses, but keeps the header well-formed).

## Risks / Trade-offs

- [Host list misses a provider that auto-saves] → user turns the setting off in the account sheet; duplicates are visible, not lost mail.
- [Append succeeds but summary fetch fails] → warning is shown although the copy exists; synchronization indexes it later. Acceptable: the warning says the copy may be missing, and the user can verify in Sent.
- [Large messages are held in memory a second time during append] → bounded by `POSTREEVE_MAX_MESSAGE_BYTES`.

## Migration Plan

None. Stored accounts without `saveSentCopy` use the host default; saving the account sheet stores the explicit value.
