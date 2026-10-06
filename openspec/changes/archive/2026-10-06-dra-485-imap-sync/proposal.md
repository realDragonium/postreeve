# Proposal

## Why
DRA-485 makes IMAP changes available to the persisted index after reconnects without repeatedly downloading unchanged summaries. Mailbox UIDVALIDITY resets must repair locations without losing conversation state.

## What Changes
- Persist bounded per-mailbox synchronization checkpoints with UIDVALIDITY and optional MODSEQ.
- Reconcile additions, flags, removals and moves through verified mailbox snapshots.
- Restart affected mailbox scans on UIDVALIDITY resets and fall back when extensions are unavailable.

## Capabilities
### New Capabilities
- `mailbox/imap-synchronization`: Incremental IMAP synchronization and safe mailbox repair.
### Modified Capabilities
None.

## Impact
IMAP provider and deterministic fixtures; consumes DRA-483's synchronization contract. No new UI or WebMCP workflow, credentials, live-mail operations or ordinary listing changes (DRA-541).
