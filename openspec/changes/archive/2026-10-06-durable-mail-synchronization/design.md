# Design

## Context
Canonical identity and conversation storage already reconcile provider observations. Account registration supplies the authenticated tenant context. Provider-specific synchronization is the next delivery wave.

## Goals / Non-Goals
Reuse canonical reconciliation and transactions, keeping provider checkpoint formats opaque. Do not add authentication, retention settings, offline UI or provider algorithms here.

## Decisions
- Use SQLite account jobs with fresh generation tokens for each claim, cancellation and replacement. A lease allows crash recovery; generation checks fence late results. Shutdown releases only its own still-running claim, preserving cancellation and replacement ownership. An in-memory-only queue cannot survive restart.
- Apply each page and its cursor in one transaction. Bounded per-collection operations and serialized page size cap resource usage without charging a message twice for its snapshot evidence.
- Stage snapshot candidate IDs and location revisions in durable tables. Completion removes only unchanged, unseen candidates, preserving partial results and concurrent observations. Never infer deletion from an ordinary page. Preserve active evidence on repeated starts, retain only the latest completed generation per scope, and reject its replay. Serialized claims and committed cursors prevent legitimate requests from reopening older history.
- Keep indexed display summaries keyed by tenant, account and canonical message, joining current locations and canonical metadata on reads. Select one deterministic location per canonical message before applying the read limit. Merge indexed rows with canonical aliases.
- Register/start the runner in backend lifecycle. Legacy providers use additive bounded listing with partial coverage until their dedicated adapters arrive.

## Risks / Trade-offs
- Hung providers may ignore abort signals → race requests against cancellation, invalidate claims and back off after timeout.
- Old cursors may require repair → leave cursor format and repair transitions to each provider.
- The compatibility adapter cannot claim complete coverage → expose partial internally; actual retention and offline behavior are later issues.

## Migration Plan
Create additive tables and a location revision column on store startup. No live data migration or credential access is needed in tests. Older code ignores these additive structures.
