# Proposals Specification

## Purpose
Covers proposals: a titled set of mailbox actions that is prepared and edited first and changes mail only after a human approves it in the UI. It defines the proposal record, its API, its status lifecycle, the human approval boundary and how applying produces a batch. The actions themselves and their per-item results are specified in actions/message-actions; batches and undo in actions/activity-undo; the agent tools, which include no proposal tools, in agents/webmcp-tools.

## Requirements

### Requirement: Proposal record
A proposal SHALL carry `id`, `accountId`, `title` (1 to 120 characters), `status`, `items`, `createdAt`, `updatedAt`, `approvedAt` (null until approved) and `batchId` (null until applied). Each item SHALL carry `id`, `message` (a stable message reference), `subject`, `action` and `reason` (at most 500 characters). An item action SHALL be one of `leave`, `move` with `destination`, `trash`, `mark_read`, `mark_unread`, `flag` or `unflag`, where `leave` changes nothing.

#### Scenario: Leave item
- **WHEN** a proposal item's action is `{ type: "leave" }`
- **THEN** applying the proposal revalidates that message and records the item as applied without changing it

### Requirement: Create a proposal
The system SHALL create a proposal at `POST /api/proposals` from `{ accountId, title, items }` with 1 to 100 items and answer 201 with the proposal in status `draft`, `approvedAt` null and `batchId` null. Every item's `message.accountId` MUST equal `accountId`; otherwise the request SHALL be refused with 400 `Every proposal item must belong to the proposal account`. An unknown account SHALL be refused with 400 `Account not found`. Creating a proposal SHALL NOT change any mail.

#### Scenario: New proposal
- **WHEN** a client creates a proposal with one `mark_read` item
- **THEN** the response is 201 with `status` `draft` and the message is still unread

#### Scenario: Item from another account
- **WHEN** a proposal for account A contains an item for account B
- **THEN** the response is 400 and no proposal is stored

### Requirement: List proposals
The system SHALL return at `GET /api/proposals?accountId=<id>` every proposal of that account in any status, most recently updated first. An unknown account SHALL be refused with 400.

#### Scenario: Listing after apply
- **WHEN** a client lists proposals after one was applied
- **THEN** that proposal is listed with status `applied` and its `batchId`

### Requirement: Edit a proposal before approval
The system SHALL update a proposal at `PUT /api/proposals/<proposalId>` with any of `title`, `items` (1 to 100, all for the proposal's account) and `status`, where `status` accepts only `review`. Only a proposal in `draft` or `review` SHALL be editable; any other SHALL be refused with 400 `Only draft or review proposals can be edited`. An update SHALL NOT approve a proposal or set `approvedAt`.

#### Scenario: Move to review
- **WHEN** a client updates a draft proposal with `{ status: "review", title: "Edited pass" }`
- **THEN** the proposal is `review` with the new title and `approvedAt` is still null

#### Scenario: Attempt to approve through an update
- **WHEN** a client updates a proposal with `{ status: "approved" }`
- **THEN** the response is 400 and the proposal is unchanged

#### Scenario: Edit after approval
- **WHEN** a client edits an approved proposal
- **THEN** the response is 400 `Only draft or review proposals can be edited`

### Requirement: Only the human-facing interface approves
The system SHALL approve a proposal only through `approveProposalFromHumanInterface`, reached by `POST /api/proposals/<proposalId>/approve`, which the web UI calls when a person accepts a proposal. Approval SHALL move a `draft` or `review` proposal to `approved` and set `approvedAt`; any other status SHALL be refused with 400 `Only a draft or review proposal can be approved`. No WebMCP tool and no other API operation SHALL approve a proposal.

#### Scenario: Human accepts
- **WHEN** the UI posts approve for a proposal in `review`
- **THEN** the proposal is `approved` with `approvedAt` set

#### Scenario: Agent tools cannot approve
- **WHEN** an agent lists the WebMCP tools
- **THEN** no tool creates, updates, approves or applies a proposal

### Requirement: Applying requires approval
The system SHALL apply a proposal at `POST /api/proposals/<proposalId>/apply` only when its status is `approved` and `approvedAt` is set; otherwise it SHALL refuse with 400 `Human approval is required before applying a proposal` and change no mail. An unknown proposal SHALL be refused with 400 `Proposal not found`.

#### Scenario: Apply a draft
- **WHEN** a client applies a proposal in `draft`
- **THEN** the response is 400 `Human approval is required before applying a proposal` and no message changes

#### Scenario: Apply twice
- **WHEN** a client applies a proposal that was already applied
- **THEN** the response is 400 and no action is repeated

### Requirement: Applying produces one batch
Applying an approved proposal SHALL set its status to `applying`, apply its items in order with the revalidation and per-item results of actions/message-actions, record one operation batch carrying the proposal's ID, and answer 200 with that batch. The proposal SHALL then take the batch's status (`applied`, `partially_applied` or `failed`) and its `batchId`.

#### Scenario: Partly stale proposal
- **WHEN** an approved proposal with one current and one stale message is applied
- **THEN** the batch is `partially_applied`, the proposal is `partially_applied` with `batchId` set, and the stale message is untouched

### Requirement: Status lifecycle
A proposal's status SHALL move only `draft` → `review` (by update), `draft` or `review` → `approved` (by approval), `approved` → `applying` → `applied`, `partially_applied` or `failed` (by apply), and `applied` or `partially_applied` → `undone` or `partially_undone` (by undoing its batch). There SHALL be no operation that rejects or deletes a proposal; proposals are removed only with their account.

#### Scenario: Undo an applied proposal
- **WHEN** the batch of an `applied` proposal is undone
- **THEN** the proposal's status becomes `undone`

### Requirement: Direct actions are recorded as approved proposals
Each direct action request (actions/message-actions), from the UI or from the `apply_message_actions` WebMCP tool, SHALL be recorded as a new proposal that the system approves and applies immediately, so its batch has a `proposalId` and the proposal has `approvedAt` set. This SHALL NOT approve or apply any other proposal.

#### Scenario: Direct action leaves an approved record
- **WHEN** a person moves a message directly
- **THEN** the returned batch's `proposalId` names a proposal with `approvedAt` set and status `applied`

### Requirement: Waiting proposals are shown on their messages
The UI SHALL NOT create, edit or reject proposals. For every item of a `draft`, `review` or `approved` proposal it SHALL mark the matching message in the list with `◇` and `proposes <action>`, show the reader strip `The assistant proposes <action> — waiting on you`, and count the waiting items per account in the sidebar. A waiting proposal SHALL take precedence over earlier activity on the same message.

#### Scenario: Settled proposal
- **WHEN** a proposal has been applied
- **THEN** its messages no longer show the proposal marker or an Accept control

### Requirement: Accepting a proposal in the UI
The UI SHALL offer `Accept` in the reader strip and `Accept proposal` in the list toolbar for the focused message of a waiting proposal. Accepting SHALL call approve and then apply, add an undo entry and show `Accepted proposal`; a failure SHALL show its error.

#### Scenario: Accept a waiting proposal
- **WHEN** a person opens a message with a waiting `mark_read` proposal and selects Accept
- **THEN** the UI approves and applies the proposal, the status reads `Accepted proposal` and the action can be undone with Cmd+Z
