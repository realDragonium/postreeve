# Proposal

## Why
DRA-483 establishes durable local indexing without an open mailbox view. Existing canonical storage needs summaries, provider checkpoints and restartable backend work.

## What Changes
- Persist bounded summaries alongside canonical messages and mutable locations.
- Run durable account jobs with leases, cancellation, retry and atomic page checkpoints.
- Define one scoped cursor contract with explicit deletion and completed snapshot evidence.
- Wire account registration and server lifecycle to the runner.

Provider-specific ingestion (DRA-484/485), retention/offline UI (DRA-486) and live-mail testing are outside this change. Existing authorization covers finishing implementation and direct main delivery. No UI or WebMCP workflow changes.

## Capabilities

### New Capabilities
- `mailbox/synchronization`: Persistent local indexing, cursor ingestion and durable account jobs.

### Modified Capabilities
None.

## Impact
SQLite store, provider interface, backend account registration and server lifecycle; deterministic tests. No new runtime dependency.
