# Design

## Context
The existing Gmail adapter maps metadata to canonical observations and has injected HTTP transport. DRA-483 commits opaque provider cursors and observations atomically.

## Goals / Non-Goals
Use the existing account scope and snapshot generations. Do not change shared ingestion ownership or human approval boundaries.

## Decisions
Capture profile history before a full listing and start an empty snapshot page before observing mail. Finish the snapshot only after history catch-up. Full message listing includes Spam and Trash. Consume small provider pages and resume within changed IDs and label fanout; this bounds each committed collection without truncating provider coverage. History IDs remain strings. Re-fetch the current metadata for changed messages instead of applying stale label events. Confirmed message absence replaces its location set with empty. A restart resumes the persisted cursor. Invalid local cursors and history 404 restart repair; other failures retain the checkpoint.

## Risks / Trade-offs
Repeated reads during label fanout trade provider calls for bounded durable state. Provider page tokens that expire restart repair, preserving local identity. HTTP response size limits reject oversized data rather than advancing an incomplete checkpoint.
