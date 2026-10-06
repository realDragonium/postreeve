# Proposal

## Why
DRA-484 needs Gmail changes reflected in the durable index after initial ingestion and after Gmail expires a history cursor.

## What Changes
- Consume account-wide history and reconcile current labels, flags, and message locations.
- Repair expired history with bounded full listing followed by history catch-up.
- Preserve local canonical, conversation, and attention identity during repair.

## Capabilities
### New Capabilities
- `mailbox/gmail-synchronization`: Gmail cursor progression, repair and provider fact reconciliation.
### Modified Capabilities
None.

## Impact
Gmail adapter and deterministic HTTP fixtures only; uses DRA-483 synchronization contract. No new API, UI workflow, WebMCP tool, dependency or live mailbox operation. IMAP and search remain outside this issue.
