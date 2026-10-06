# Spec Delta

## Purpose
Keep indexed IMAP mailbox locations current across reconnects, extension differences and mailbox identity resets while preserving conversation state.

## ADDED Requirements

### Requirement: Durable bounded mailbox checkpoints
Synchronization SHALL resume each account mailbox from its own persisted UIDVALIDITY and bounded checkpoint, using negotiated QRESYNC and MODSEQ where available. A server without persistent modification sequences SHALL remain supported.

#### Scenario: Reconnect during a scan
- **WHEN** synchronization reconnects after a committed page
- **THEN** it resumes the mailbox scan without skipping unprocessed UIDs

#### Scenario: Extensions unavailable
- **WHEN** a server does not negotiate QRESYNC or persistent MODSEQ
- **THEN** bounded full-summary observations still update mailbox locations

### Requirement: Incremental location updates
Synchronization SHALL ingest additions and flag changes and reconcile disappearances only after completing a mailbox snapshot. Moves SHALL converge to the correct source and destination locations while retaining canonical identity for matching valid Message-ID values.

#### Scenario: External move
- **WHEN** a message moves from Inbox to Archive while disconnected
- **THEN** subsequent completed scans remove its old location and ingest its new location under the same canonical message

### Requirement: Incomplete observations preserve checkpoints
A missing, duplicate, unexpected or incomplete fetched summary SHALL NOT advance the mailbox checkpoint or complete a snapshot. Failed searches SHALL NOT establish an empty mailbox. SEARCH results SHALL prove full coverage; partial results, missing requested counts and inconsistent unique UID counts SHALL fail before reconciliation.

#### Scenario: FETCH silently omits a requested UID
- **WHEN** SEARCH finds two UIDs but FETCH returns only one
- **THEN** the page fails and retry starts from the previous committed checkpoint without removing cached locations

#### Scenario: SEARCH includes a partial result or inconsistent count
- **WHEN** SEARCH reports one UID with a count of three or includes PARTIAL evidence
- **THEN** synchronization rejects the observation without changing the checkpoint or removing indexed locations

#### Scenario: Client normalizes an uncertain plain SEARCH response
- **WHEN** the client discards malformed SEARCH tokens, truncates results or receives no SEARCH response before command completion
- **THEN** synchronization rejects the command using protocol-level evidence even if normalized ALL and COUNT agree

#### Scenario: Confirmed empty plain SEARCH
- **WHEN** a server without ESEARCH returns an explicit empty SEARCH response and successful completion
- **THEN** synchronization may complete an empty snapshot and reconcile removals

### Requirement: Mailbox reset repair
A changed UIDVALIDITY SHALL start a new snapshot for only the affected mailbox. Completing that snapshot SHALL replace obsolete locations while retaining canonical messages and provider-independent conversation state.

#### Scenario: Reset during a paginated scan
- **WHEN** UIDVALIDITY changes before the next page
- **THEN** synchronization restarts that mailbox and never completes the obsolete generation

### Requirement: Byte-bounded synchronization pages
Synchronization SHALL keep each emitted page within the 2 MiB serialized UTF-8 limit. When a batch exceeds the limit, it SHALL emit a fitting UID prefix and advance only that prefix's checkpoint and coverage. An individually unrepresentable summary SHALL fail as invalid data without truncating identity, skipping the message or completing coverage.

#### Scenario: Large batch of representable summaries
- **WHEN** a fetched batch exceeds the page byte limit but its individual summaries fit
- **THEN** subsequent committed pages ingest every summary without losing fields or skipping UIDs

#### Scenario: One summary exceeds the byte limit
- **WHEN** the next individual summary cannot fit in a page
- **THEN** synchronization reports invalid data and retains the previous checkpoint and cached locations
