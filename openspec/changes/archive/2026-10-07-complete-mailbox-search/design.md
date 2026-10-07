# Design
## Context
Existing SyncStore retains bounded summary JSON and exact mutable locations. IMAP already parses 64KiB MIME source; Gmail synchronization requests metadata. UI and WebMCP currently load at most 100 provider results.
## Goals / Non-Goals
Use existing tenant/canonical/location model; no frozen snapshot or Gmail language promise. No live mail tests.
## Decisions
- One POST query takes validated explicit account/mailbox sources, query, filter and sort. This lets the backend own unified ordering while reusing UI folder discovery.
- Keyset value plus canonical ID prevents offset shifts; cursors bind the normalized query and tenant. First-indexed date/sender/subject fields remain in the indexed JSON. The earliest canonical row supplies sort keys independently of the matching location; later duplicate copies cannot move that anchor. Canonical merges retain the surviving identity’s keys. A tenant/message index bounds anchor lookup. Existing account GET remains first-page compatible.
- SQLite FTS5 trigram index covers normalized exact fields. Literal substring confirmation prevents token-language surprises; short queries use exact field scans.
- Search-only fields stay in existing indexed JSON, with trigger-maintained FTS and content accounting so canonical merges retain coherent indexes.
- IMAP bounded MIME parsing and Gmail bounded full payload ingestion populate body text during synchronization. Missing/oversized text is explicit; no on-demand-only claim. Retention clears both preview and body.
- Partial coverage uses bounded provider fallback on the first page, persists observations additively, and keeps cached pages usable if a provider fails. Coverage never claims fallback is exhaustive.
## Risks / Trade-offs
Bounded MIME/body content is incomplete for large messages → return text bounds and missing counts, allow provider fallback. New mail may appear after the keyset or require refresh before it → no snapshot promise. Runtime sort/short text scans cost more on large stores → indexed keyset fields and trigram search.
## Migration Plan
Add FTS triggers/index from existing JSON; existing rows retain metadata and report absent body text. Apply and archive specs with code after deterministic verification.
