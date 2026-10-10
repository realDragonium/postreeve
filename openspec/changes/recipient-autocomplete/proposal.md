# Proposal

## Why

Postreeve is meant to replace Apple Mail for a person with many addresses. Compose recipient fields offer no suggestions, so every address must be typed in full or copied from another message. The synchronized index already holds the From, To and Cc headers of the person's mail across all accounts, which is enough to suggest the people they correspond with.

## What Changes

- The system maintains, per account, the addresses the person corresponds with, derived from the From, To and Cc headers in the local synchronized index: how often the person sent to each address, how often each address mailed them, the most recent date and the most recent display name.
- A new endpoint `GET /api/recipient-suggestions?q=…&limit=…` answers matching addresses from local data only, with strict input limits and a result cap. It never calls a mail provider.
- Suggestions match the query case-insensitively against address or display name, exclude the person's own account addresses and identities, merge accounts by normalized address and rank addresses the person sent to above people who only mailed them, then by frequency and recency.
- The To, Cc and Bcc fields show suggestions for the address being typed. Arrow keys move through them, Enter or Tab accepts, Escape closes. The fields stay comma-separated text, so pasting lists and the existing address validation are unchanged.
- Removing an account removes its contribution; suggestions follow what the index retains (headers, not bodies).
- WebMCP does not change: `send_message` already takes explicit addresses and suggestions are a typing aid in the human compose form.

## Capabilities

### New Capabilities

- `compose/recipient-suggestions`: Suggesting recipient addresses from the person's local mail history, its API and its use in the compose recipient fields.

### Modified Capabilities

None.

## Impact

New server module and SQLite table with triggers on `indexed_messages` (no changes to synchronization code), core service method, HTTP API route, shared contract, web API client, compose recipient fields in `src/web/panels.tsx`, styles, tests and FEATURES.md. Linear issue: none named for this run.
