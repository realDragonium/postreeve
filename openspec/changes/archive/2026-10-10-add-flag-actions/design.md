# Design
## Context
`mark_read`/`mark_unread` already run end to end: `triageActionSchema` → provider `apply` (records `previousRead`) → `#recordProviderMove` → `SynchronizationStore.confirmedAction(read)` → batch; undo calls provider `undo` and restores read state in the index. Flags follow the same path.
## Decisions
- **Two explicit actions, not a toggle.** `flag` and `unflag` are idempotent and mirror `mark_read`/`mark_unread`; the UI decides which to send from the message's current state, as `u` does today.
- **Shared action type.** Adding them to `triageActionSchema` makes proposals accept them too. Keeping proposals narrower would need a second schema for no concrete benefit.
- **Undo data.** `AppliedMailAction` gains `previousFlagged`. It is optional in the type because batches stored before this change lack it; those batches contain no flag operations, so undo of a flag operation always has it. Undo of a flag operation restores exactly the recorded state.
- **Index update.** `confirmedAction` takes an optional `{ read, flagged }` state instead of `read` alone. Gmail labels are per message, so a Gmail flag change updates every location with the same provider ID, as read state already does; IMAP flags stay location-specific.
- **IMAP undo safety.** Flag undo uses the same check as read undo: the message must still be at the UID the action left it with.
- **UI.** Reader: one `Flag`/`Unflag` chip. List selection: `Flag` and `Unflag` chips (a mixed selection has no single toggle). Shortcut `s` (Gmail convention) toggles from the focused message's state across the selection, like `u`. Flagged rows show `⚑` in the mark column when no proposal mark occupies it. Status: `Flagged <n>` / `Unflagged <n>`; Activity: `flagged` / `unflagged`.
## Risks
- An IMAP server without `\Flagged` support in PERMANENTFLAGS would refuse the store; the item fails individually with the provider's error, which is acceptable.
