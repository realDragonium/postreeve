# Spec Delta

## Purpose
Keeps the local Gmail index current through account history and safely repairs expired provider synchronization state.

## ADDED Requirements

### Requirement: Gmail changes reconcile provider facts
The system SHALL consume Gmail history for the exact account from a durable cursor, reconcile current message labels and flags, and remove only confirmed missing locations. Duplicate observations SHALL preserve canonical and conversation identity.

#### Scenario: Label change and duplicate event
- **WHEN** Gmail repeats an event for a message moved from Inbox to a custom label
- **THEN** the existing canonical message retains its conversation, has the current labels and flags, and loses its former Inbox location

#### Scenario: Metadata is incomplete
- **WHEN** Gmail omits required synchronization metadata or explicit header evidence
- **THEN** ingestion fails without changing indexed content, flags, locations or the committed cursor

### Requirement: Gmail repair remains bounded and resumable
The system SHALL repair missing, invalid or expired cursors using bounded pages, report catching-up during repair, and resume committed progress after interruption. It SHALL catch up changes occurring during full listing before claiming complete coverage.

#### Scenario: Expired history and interrupted listing
- **WHEN** Gmail rejects the stored history and a repair stops between pages
- **THEN** the account reports catching-up, retains unseen locations, and resumes at the last committed page

#### Scenario: Changes during repair
- **WHEN** Gmail changes a message while the full listing is in progress
- **THEN** history catch-up reconciles that change before complete coverage is reported

#### Scenario: Repair cursors repeatedly fail
- **WHEN** an unfinished repair exhausts three restarts after Gmail rejects its cursor or page token
- **THEN** synchronization reports a failure and retains its current cursor instead of silently starting another generation

#### Scenario: Labels multiply a large summary
- **WHEN** a message belongs to enough labels that its expanded observations exceed a page's byte limit
- **THEN** observations continue over bounded pages without trimming message identity, and the exact location set is applied after all locations have been observed

#### Scenario: One observation cannot fit
- **WHEN** a single canonical observation exceeds the synchronization page byte limit
- **THEN** synchronization reports invalid data without advancing its checkpoint or truncating identity headers

### Requirement: Gmail repair preserves local workflow state
Repair SHALL retain canonical, conversation and attention identity while replacing provider facts. Unseen locations SHALL be removed only after a completed account snapshot; unrelated accounts and tenants SHALL remain untouched.

#### Scenario: Repair after a local workflow references a conversation
- **WHEN** an expired cursor is repaired for an existing conversation referenced by a local workflow
- **THEN** that conversation retains its identity and local workflow references while its current Gmail locations are reconciled
