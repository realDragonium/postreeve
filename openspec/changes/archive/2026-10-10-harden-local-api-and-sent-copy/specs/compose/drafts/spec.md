## ADDED Requirements

### Requirement: A delivered draft is recorded before its Sent copy
The system SHALL record a draft's delivery outcome before saving any Sent copy (compose/sending), so a slow or failing Sent copy never delays the outcome or changes its status.

#### Scenario: Sent copy pending
- **WHEN** a draft's message is accepted and its Sent copy is still being appended
- **THEN** the draft is already `sent` with its receipt, and a server restart at that moment leaves it `sent`
