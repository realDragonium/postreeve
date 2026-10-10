## MODIFIED Requirements

### Requirement: Folder counts refresh while the page is open
The web interface SHALL refetch every account's folder list every 15 seconds while the page is open, after each mailbox action, undo, accepted proposal or sent message, and after a mailbox-change event for that account, so that counts reflect changes made elsewhere.

#### Scenario: External change appears
- **WHEN** a new message arrives in the Inbox from another client while Postreeve is open
- **THEN** the Inbox counts update within about 15 seconds without a reload

#### Scenario: Pushed change appears
- **WHEN** the page receives a mailbox-change event for an account
- **THEN** that account's folder list is requested again without waiting for the 15-second poll
