## ADDED Requirements

### Requirement: Provider change notifications expedite synchronization
A provider change notification for an account mailbox SHALL make that mailbox's durable synchronization scope and its account job due immediately, without a separate ingestion path. It SHALL NOT shorten a retry delay, resume a canceled or unavailable job, or bypass a reauthorization pause. A notification for an undiscovered mailbox SHALL be ignored.

#### Scenario: Change notification while idle
- **WHEN** a provider reports a change in an account's Inbox and its job is queued for a later poll
- **THEN** synchronization fetches that Inbox scope without waiting for the poll interval

#### Scenario: Account needs reauthorization
- **WHEN** a provider change notification arrives for an account whose job is paused for reauthorization
- **THEN** the job stays paused
