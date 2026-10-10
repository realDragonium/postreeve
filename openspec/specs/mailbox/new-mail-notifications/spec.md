# mailbox/new-mail-notifications Specification

## Purpose
Tells the person promptly that new mail arrived: the open page learns about synchronized mailbox changes as they commit, and new unread Inbox mail raises a desktop notification that opens the message.

## Requirements

### Requirement: Synchronization identifies new arrivals
Synchronization SHALL report a message as a new arrival only when it is unread, located in an account's Inbox, first indexed by the committed page, and that page's scope had already completed at least one snapshot. Each canonical message SHALL be reported at most once per page.

#### Scenario: Mail arrives after the Inbox is synchronized
- **WHEN** an unread message appears in an Inbox whose scope has completed a snapshot
- **THEN** the committed page reports it as a new arrival

#### Scenario: Initial backfill
- **WHEN** a newly connected account synchronizes its existing Inbox for the first time
- **THEN** no message is reported as a new arrival

#### Scenario: Repair or move of a known message
- **WHEN** a repair rescans the Inbox, or a message that was already indexed in another folder moves into the Inbox
- **THEN** no message is reported as a new arrival

#### Scenario: Read or non-Inbox mail
- **WHEN** a new message is already read, or is delivered only to a folder other than the Inbox
- **THEN** it is not reported as a new arrival

### Requirement: The open page receives mailbox events
The server SHALL stream events to the open page at `GET /api/events` as Server-Sent Events: a mailbox-change event naming the account after any committed synchronization page that added, removed or moved an indexed location or changed its read or flagged state, and a new-mail event with each arrival's account, mailbox, canonical identity, sender and subject. Events SHALL carry no body content or credentials, and the stream SHALL send a keep-alive at least every 15 seconds.

#### Scenario: Change pushed to the page
- **WHEN** synchronization commits new messages for an account while the page is open
- **THEN** the page receives a mailbox-change event for that account and, for arrivals, a new-mail event

#### Scenario: Unchanged rescan
- **WHEN** a rescan page re-sends summaries identical to the indexed locations
- **THEN** no mailbox-change event is sent

#### Scenario: Stream reconnects
- **WHEN** the event stream closes or fails
- **THEN** the page reconnects with increasing delay and keeps working through the folder poll meanwhile

### Requirement: Desktop notifications for new arrivals
The web interface SHALL show an operating-system notification for each new-mail arrival when notifications are enabled, permission is granted, the arrival's account is not muted and the window does not have focus. More than three arrivals from one event SHALL produce one summary notification. Clicking a notification SHALL focus the window and open the message in its account's Inbox.

#### Scenario: Message arrives in the background
- **WHEN** an arrival event reaches a page whose window is not focused and notifications are enabled
- **THEN** a notification shows the sender and subject, and clicking it opens that message

#### Scenario: Window focused
- **WHEN** an arrival event reaches a focused window
- **THEN** no notification is shown and the list refreshes

#### Scenario: Burst of arrivals
- **WHEN** one event reports five arrivals
- **THEN** one notification summarizes five new messages

### Requirement: Notification settings
Settings SHALL include a Notifications section with a switch that enables desktop notifications, requesting operating-system permission from that action, and a per-account mute. Notifications SHALL be off until the person enables them. Settings SHALL persist in the browser profile and SHALL state when the operating system has denied permission.

#### Scenario: Enable notifications
- **WHEN** a person turns notifications on and grants permission
- **THEN** later arrivals from unmuted accounts raise notifications

#### Scenario: Mute one account
- **WHEN** a person mutes an account
- **THEN** arrivals from that account raise no notification while other accounts still do

#### Scenario: Permission denied
- **WHEN** the operating system denies notification permission
- **THEN** notifications stay off and the section explains that permission was denied
