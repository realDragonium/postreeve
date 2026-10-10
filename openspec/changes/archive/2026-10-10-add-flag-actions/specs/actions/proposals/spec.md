## MODIFIED Requirements

### Requirement: Proposal record
A proposal SHALL carry `id`, `accountId`, `title` (1 to 120 characters), `status`, `items`, `createdAt`, `updatedAt`, `approvedAt` (null until approved) and `batchId` (null until applied). Each item SHALL carry `id`, `message` (a stable message reference), `subject`, `action` and `reason` (at most 500 characters). An item action SHALL be one of `leave`, `move` with `destination`, `trash`, `mark_read`, `mark_unread`, `flag` or `unflag`, where `leave` changes nothing.

#### Scenario: Leave item
- **WHEN** a proposal item's action is `{ type: "leave" }`
- **THEN** applying the proposal revalidates that message and records the item as applied without changing it
