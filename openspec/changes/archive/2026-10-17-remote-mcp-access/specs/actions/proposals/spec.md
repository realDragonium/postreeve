# Spec Delta

## MODIFIED Requirements

### Requirement: Only the human-facing interface approves
The system SHALL approve a proposal only through `approveProposalFromHumanInterface`, reached by `POST /api/proposals/<proposalId>/approve`, which the web UI calls when a person accepts a proposal. Approval SHALL move a `draft` or `review` proposal to `approved` and set `approvedAt`; any other status SHALL be refused with 400 `Only a draft or review proposal can be approved`. No agent tool (WebMCP or remote MCP) and no other API operation SHALL approve or apply a proposal.

#### Scenario: Human accepts
- **WHEN** the UI posts approve for a proposal in `review`
- **THEN** the proposal is `approved` with `approvedAt` set

#### Scenario: Agent tools cannot approve
- **WHEN** an agent lists the WebMCP or remote MCP tools
- **THEN** no tool approves or applies a proposal, and `update_proposal` refuses any status other than `review`

#### Scenario: Remote agent prepares, person accepts
- **WHEN** a remote agent creates a proposal and the person selects Accept in the UI
- **THEN** the proposal is approved and applied only by that UI action
