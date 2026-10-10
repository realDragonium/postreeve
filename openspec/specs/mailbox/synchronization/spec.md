# Synchronization Specification

## Purpose
Maintain a local index through durable, scoped synchronization independently of whether a mailbox view is open.

## Requirements

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

### Requirement: Account synchronization health
The system SHALL expose healthy, catching-up, degraded, disconnected and reauthorization-required account states from durable job evidence and provider availability. It SHALL retain the latest actionable classified failure and its time through retry until successful provider progress, without retaining provider error text, credentials or cursors in health responses. A provider registration failure SHALL leave other accounts usable. Global credential-vault validation SHALL remain enforced.

#### Scenario: Retry after a transient failure
- **WHEN** a person retries a degraded account
- **THEN** its current failure remains visible until a successful synchronization page clears it

#### Scenario: Authorization expired
- **WHEN** a provider reports authentication failure
- **THEN** health requires reauthorization and automatic retries pause until credentials are replaced or the person explicitly requests a retry

#### Scenario: Provider unavailable at startup
- **WHEN** one account cannot register its provider
- **THEN** that account is disconnected and other accounts can synchronize

#### Scenario: Global key unavailable
- **WHEN** stored encrypted accounts exist but the server master key is missing
- **THEN** initialization fails before per-account registration failures are handled

#### Scenario: Stored secret cannot be authenticated
- **WHEN** a syntactically valid master key cannot decrypt stored credentials or the stored ciphertext is corrupt
- **THEN** initialization fails before provider registration rather than classifying the failure as a disconnected account

#### Scenario: Credentials replaced
- **WHEN** verified IMAP settings or Gmail authorization replace account credentials
- **THEN** synchronization restarts while preserving the latest failure and last-success evidence until a new page commits

#### Scenario: Startup configuration restored
- **WHEN** provider registration succeeds after a previous startup configuration failure
- **THEN** background synchronization resumes unless the job was intentionally canceled or paused for reauthorization

### Requirement: Bounded disposable content retention
The system SHALL expire indexed preview content after a configurable age since refresh (30 days by default) and evict oldest content until each account fits its configurable UTF-8 content budget (100 MiB by default). It SHALL enforce retention after indexing and during background maintenance even when no provider work succeeds.

#### Scenario: Age and budget exceeded
- **WHEN** previews exceed their configured age or account budget
- **THEN** eligible preview text is cleared and those messages remain navigable with the same identity and flags

#### Scenario: Account isolation
- **WHEN** retention runs for one tenant and account
- **THEN** content belonging to other tenants or accounts is unchanged

### Requirement: Client synchronization recovery
The UI and agents SHALL inspect account health and retention policy, request safe synchronization retry, and request instructions for human reauthorization through existing Gmail OAuth or IMAP account settings. Health reads SHALL use local evidence and retry SHALL NOT change provider mail or grant an agent credentials or proposal approval.

#### Scenario: Inspect and recover
- **WHEN** a person opens Sync & storage or an agent inspects synchronization
- **THEN** each account shows state, current actionable failure, retry availability and retention policy
- **AND** reauthorization instructions direct the person to the existing authorization interface

### Requirement: Retention preserves navigation and identity
Retention SHALL preserve all indexed summary rows, canonical identities, mutable locations, conversation links, drafts and proposal metadata, and SHALL NOT change provider mail. The displayed policy SHALL distinguish disposable content bounds from retained navigation metadata and total database size.

#### Scenario: Preview expired for an active conversation
- **WHEN** a preview expires for an unread or flagged conversation
- **THEN** the same message remains navigable with unchanged identity, flags and workflow references

### Requirement: Provider change notifications expedite synchronization
A provider change notification for an account mailbox SHALL make that mailbox's durable synchronization scope and its account job due immediately, without a separate ingestion path. It SHALL NOT shorten a retry delay, resume a canceled or unavailable job, or bypass a reauthorization pause. A notification for an undiscovered mailbox SHALL be ignored.

#### Scenario: Change notification while idle
- **WHEN** a provider reports a change in an account's Inbox and its job is queued for a later poll
- **THEN** synchronization fetches that Inbox scope without waiting for the poll interval

#### Scenario: Account needs reauthorization
- **WHEN** a provider change notification arrives for an account whose job is paused for reauthorization
- **THEN** the job stays paused
