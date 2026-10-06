# Synchronization Delta

## Purpose
Maintain a local index through durable, scoped synchronization independently of whether a mailbox view is open.

## ADDED Requirements

### Requirement: Persist summaries and checkpoints atomically
The system SHALL retain canonical metadata, mutable locations and flags, bounded previews and provider checkpoints in the local index. A failed page SHALL change neither its checkpoint nor any indexed data. Duplicate observations SHALL preserve canonical identity.

#### Scenario: Duplicate page
- **WHEN** synchronization observes a previously committed message again
- **THEN** the index contains the same canonical message with its latest location flags and preview

#### Scenario: Duplicate physical copies
- **WHEN** one mailbox contains several physical copies of a canonical message
- **THEN** indexed reads choose one deterministic location with its current flags before applying the requested limit

#### Scenario: Failed page
- **WHEN** a page fails validation or reconciliation
- **THEN** its previous checkpoint and indexed data remain available

### Requirement: Durable account jobs
The system SHALL schedule synchronization for connected accounts without an open mailbox view, persist retry state and recover interrupted work. Cancellation, account removal and replacement SHALL invalidate outstanding work so late results cannot commit.

#### Scenario: Restart during work
- **WHEN** a process restarts with an expired running job
- **THEN** another worker resumes from its last committed checkpoint and the earlier worker cannot commit

#### Scenario: Provider failure
- **WHEN** provider work fails or times out
- **THEN** a bounded exponential retry delay is persisted without storing provider error text

#### Scenario: Disconnected account
- **WHEN** an account is removed while a provider request remains outstanding
- **THEN** its job and indexed summaries are removed and the response cannot recreate them

### Requirement: Scoped ingestion contract
Provider ingestion SHALL use an opaque cursor with a tenant, account and optional mailbox boundary. A partial page SHALL preserve unseen locations. Only explicit provider removals, exact Gmail label sets or completed snapshot generations SHALL remove locations within that boundary.

#### Scenario: Partial repair
- **WHEN** a repair commits an incomplete snapshot then fails
- **THEN** unseen locations remain until a completed generation confirms their absence

#### Scenario: Concurrent observation during repair
- **WHEN** a location is updated after a snapshot starts but is absent from its remaining pages
- **THEN** snapshot completion preserves that newer observation

#### Scenario: Foreign reference
- **WHEN** ingestion returns a reference outside its account or mailbox
- **THEN** the page is rejected without changes

#### Scenario: Replayed snapshot generation
- **WHEN** an active snapshot start is repeated
- **THEN** its original candidate revisions and accumulated observations remain unchanged
- **AND** replay of the most recently completed generation is rejected without modifying the index or checkpoint
