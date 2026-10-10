# Proposal
## Why
Flagging for follow-up is a core triage action, but `flagged` is read-only today: it can be filtered and displayed, never changed. A daily-driver client needs to flag and unflag from the reader, the list and the keyboard, with the same audit and undo guarantees as the other actions.
## What Changes
- New direct actions `flag` and `unflag`, applied as the IMAP `\Flagged` flag or the Gmail `STARRED` label, with revalidation, per-item results, audited batches and undo restoring the previous flag state.
- The local index records the confirmed flag change so the Flagged filter reflects it immediately; on Gmail every location of the message follows, as for read state.
- UI: Flag/Unflag in the reader, Flag and Unflag for a list selection, the `s` shortcut, a flag mark on flagged rows, status and undo feedback.
- WebMCP `apply_message_actions` accepts `flag` and `unflag`; proposals accept them through the shared action type.
- Replaces "Flagging is not available".
## Capabilities
### New Capabilities
### Modified Capabilities
- `actions/message-actions`: flag/unflag actions, UI controls, shortcut and feedback; removes the flagging prohibition.
- `actions/activity-undo`: undo restores the previous flag state.
- `actions/proposals`: item actions include `flag` and `unflag`.
- `agents/webmcp-tools`: `apply_message_actions` accepts `flag` and `unflag`.
- `mailbox/message-listing`: confirmed Gmail flag changes update all locations.
## Impact
Shared action contract, IMAP and Gmail providers, test mail double, core apply/undo, synchronization index, React reader/list/App, WebMCP tool schema, FEATURES.md. No schema migration: the previous flag state is stored with the existing JSON undo data.
