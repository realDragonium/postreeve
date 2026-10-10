## MODIFIED Requirements

### Requirement: The list refreshes after changes
The web interface SHALL request the visible message lists again after a mailbox action, undo or accepted proposal completes, after a folder is created, renamed or deleted, after **Try again**, after a message is sent, and after mailbox-change events, coalescing events received within one second. The message list is not polled on a timer.

#### Scenario: Moved message leaves the list
- **WHEN** a person moves a message from Inbox to Archive
- **THEN** the Inbox list is requested again and no longer shows the message

#### Scenario: New mail appears
- **WHEN** synchronization commits a new Inbox message while the Inbox is visible
- **THEN** the list is requested again and shows the message without a reload
