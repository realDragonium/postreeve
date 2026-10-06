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
A missing, duplicate, unexpected or incomplete fetched summary SHALL NOT advance the mailbox checkpoint or complete a snapshot. Failed searches SHALL NOT establish an empty mailbox.

#### Scenario: FETCH silently omits a requested UID
- **WHEN** SEARCH finds two UIDs but FETCH returns only one
- **THEN** the page fails and retry starts from the previous committed checkpoint without removing cached locations

### Requirement: Mailbox reset repair
A changed UIDVALIDITY SHALL start a new snapshot for only the affected mailbox. Completing that snapshot SHALL replace obsolete locations while retaining canonical messages and provider-independent conversation state.

#### Scenario: Reset during a paginated scan
- **WHEN** UIDVALIDITY changes before the next page
- **THEN** synchronization restarts that mailbox and never completes the obsolete generation
