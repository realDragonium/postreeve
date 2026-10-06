# Design

## Context
The existing Gmail adapter maps metadata to canonical observations and has injected HTTP transport. DRA-483 commits opaque provider cursors and observations atomically.

## Goals / Non-Goals
Use the existing account scope and snapshot generations. Do not change shared ingestion ownership or human approval boundaries.

## Decisions
Capture profile history before a full listing and start an empty snapshot page before observing mail. Finish the snapshot only after history catch-up. Full message listing includes Spam and Trash. Consume small provider pages and resume within changed IDs and label fanout; this bounds each committed collection without truncating provider coverage. History IDs remain strings. Re-fetch the current metadata for changed messages instead of applying stale label events. Confirmed message absence replaces its location set with empty. A restart resumes the persisted cursor. Invalid local cursors and history 404 restart repair; other failures retain the checkpoint.

## Risks / Trade-offs
Repeated reads during label fanout trade provider calls for bounded durable state. Provider page tokens that expire restart repair, preserving local identity. HTTP response size limits reject oversized data rather than advancing an incomplete checkpoint.

## Review repairs

Synchronization metadata requires Gmail thread/history/date fields and an explicitly present header list; RFC Message-ID and Subject remain optional. Invalid metadata never emits observations or exact location sets.

An unfinished repair retains a restart count in its opaque cursor, allowing three automatic restarts before surfacing the existing provider failure/backoff. Completion clears the budget; successful resumption or an explicit replacement schedule can recover.

The 2 MiB response bound alone does not bound label-expanded observations. The adapter also measures serialized summary/page bytes, emits a resumable prefix and, when necessary, defers the exact location set to its next page. One unrepresentable summary fails as invalid data without trimming identity.

History resumes within one record requested with maxResults=1. Gmail documents chronological increasing history IDs and that maxResults counts history records; subsequent events are newer records rather than inserts before that record. A pending message pins its ID and continuation fields through label fanout; expiry enters bounded repair. The deterministic interruption fixture covers multiple IDs in that record while newer history arrives. No unbounded list of pending IDs is stored. Reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
