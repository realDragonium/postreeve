# Design

## Context
The provider opens a fresh ImapFlow connection per operation. DRA-483 persists opaque provider cursors and generation-scoped mailbox snapshots atomically with observations.

## Goals / Non-Goals
Keep provider state bounded and avoid downloading unchanged summaries. Ordinary listMessagePage completeness (DRA-541), live provider tests, and new UI/WebMCP workflows are excluded.

## Decisions
Use bounded ascending UID scans and completed mailbox snapshots as removal proof, avoiding an unbounded UID inventory in cursors or dependency on VANISHED event delivery. Each cycle captures UIDNEXT and HIGHESTMODSEQ before fetching. Retain the previous complete watermark until the entire scan completes, so changes during a scan remain eligible next cycle. SEARCH requests ALL and COUNT, rejects PARTIAL evidence, and validates the unique cardinality of normalized UID ranges without expanding the entire namespace. SEARCH MODSEQ selects changed UIDs; fetch those plus new UIDs and require exact coverage. Fall back to fetching every page when CONDSTORE is unavailable or the mailbox reports NOMODSEQ. Negotiate QRESYNC on read-only opens where possible; authoritative reconciliation still comes from the bounded scan.

Emitted pages fit the 2 MiB serialized UTF-8 bound. Oversized batches emit the largest fitting UID prefix; only emitted observations contribute snapshot evidence or checkpoint advancement. An individually oversized summary fails as invalid data without trimming canonical or presentation fields.

## Risks / Trade-offs
Membership scanning costs SEARCH requests each cycle, but avoids downloading unchanged message content and supports non-QRESYNC servers. Silent FETCH truncation fails the page rather than advancing the cursor. UID resets preserve canonical records; messages without valid Message-ID cannot be inferred identical across unrelated UID namespaces.

## Migration Plan
No schema migration: synchronization checkpoints use DRA-483 storage. Missing or malformed cursors restart a safe snapshot. Existing ordinary provider operations remain unchanged.
