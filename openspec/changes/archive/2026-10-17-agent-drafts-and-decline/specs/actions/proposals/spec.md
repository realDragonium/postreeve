# Spec Delta

## ADDED Requirements

### Requirement: Only the person declines
The system SHALL decline a proposal only through `POST /api/proposals/<proposalId>/decline`, which the web UI calls when a person declines. Declining SHALL move a `draft`, `review` or `approved` proposal to `declined` and change no mail; any other status SHALL be refused with 400 `Only a waiting proposal can be declined`. No agent tool SHALL decline a proposal.

#### Scenario: Person declines
- **WHEN** the UI posts decline for a proposal in `review`
- **THEN** the proposal is `declined`, its messages are unchanged and it no longer waits

#### Scenario: Decline after apply
- **WHEN** a client declines an applied proposal
- **THEN** the response is 400 `Only a waiting proposal can be declined`

## MODIFIED Requirements

### Requirement: Proposal record
A proposal SHALL carry `id`, `accountId`, `title` (1 to 120 characters), `status` (including `declined`), `items`, `createdAt`, `updatedAt`, `approvedAt` (null until approved) and `batchId` (null until applied). Each item SHALL carry `id`, `message` (a stable message reference), `subject`, `action` and `reason` (at most 500 characters). An item action SHALL be one of `leave`, `move` with `destination`, `trash`, `mark_read`, `mark_unread`, `flag` or `unflag`, where `leave` changes nothing.

#### Scenario: Leave item
- **WHEN** a proposal item's action is `{ type: "leave" }`
- **THEN** applying the proposal revalidates that message and records the item as applied without changing it

### Requirement: Status lifecycle
A proposal's status SHALL move only `draft` → `review` (by update), `draft` or `review` → `approved` (by approval), `draft`, `review` or `approved` → `declined` (by decline), `approved` → `applying` → `applied`, `partially_applied` or `failed` (by apply), and `applied` or `partially_applied` → `undone` or `partially_undone` (by undoing its batch). There SHALL be no operation that deletes a proposal; proposals are removed only with their account.

#### Scenario: Undo an applied proposal
- **WHEN** the batch of an `applied` proposal is undone
- **THEN** the proposal's status becomes `undone`

#### Scenario: Declined is final
- **WHEN** a client updates, approves or applies a declined proposal
- **THEN** the request is refused and the proposal stays `declined`

### Requirement: Waiting proposals are shown on their messages
The UI SHALL NOT create or edit proposals. For every item of a `draft`, `review` or `approved` proposal it SHALL mark the matching message in the list with `◇` and `proposes <action>`, show the reader strip `The assistant proposes <action> — waiting on you` with Accept and Decline, and count the waiting items per account in the sidebar. A waiting proposal SHALL take precedence over earlier activity on the same message.

#### Scenario: Settled proposal
- **WHEN** a proposal has been applied
- **THEN** its messages no longer show the proposal marker or an Accept control

#### Scenario: Decline from the reader
- **WHEN** a person selects Decline on a waiting proposal
- **THEN** the marker disappears and the status reads `Declined proposal`
