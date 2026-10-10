## ADDED Requirements

### Requirement: Gmail history poll interval
After Gmail synchronization completes a page with no more pages pending, the account scope SHALL become due again after 20 seconds rather than the general synchronization poll interval. Retry delays after failures SHALL be unchanged.

#### Scenario: Idle Gmail account
- **WHEN** Gmail history synchronization finishes with no pending changes
- **THEN** the next history request is due 20 seconds later
