## ADDED Requirements

### Requirement: IMAP Inbox change watch
For each IMAP account with a registered provider and a job that is not canceled, unavailable or paused for reauthorization, the system SHALL hold at most one connection idling on INBOX when the server advertises IDLE. New, expunged or flag-changed messages and each successful watch connection SHALL expedite the INBOX scope. IDLE SHALL be restarted no later than 25 minutes after it began. Lost connections SHALL reconnect with bounded exponential backoff.

#### Scenario: New message while idling
- **WHEN** the server sends EXISTS for INBOX on the watch connection
- **THEN** the INBOX scope is synchronized without waiting for the poll interval

#### Scenario: Server without IDLE
- **WHEN** the server does not advertise IDLE
- **THEN** the watch connection is closed and the account keeps the regular polling schedule

#### Scenario: Watch connection drops
- **WHEN** the watch connection closes unexpectedly
- **THEN** it reconnects after a delay that grows with consecutive failures and is capped

#### Scenario: Account removed or credentials rejected
- **WHEN** an account is removed, becomes unavailable or its job requires reauthorization
- **THEN** its watch connection is closed and not reopened until the account is usable again

### Requirement: New mail first in mailbox scans
When a new scan of a mailbox starts after an earlier completed scan, synchronization SHALL first ingest UIDs above the earlier scan's ceiling, in bounded pages, before scanning the rest of the mailbox. Advancing past those UIDs SHALL NOT complete a snapshot or remove locations.

#### Scenario: Large Inbox receives a message
- **WHEN** an Inbox with thousands of messages has completed a scan and one new message arrives
- **THEN** the first page of the next scan ingests the new message
