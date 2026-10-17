## MODIFIED Requirements

### Requirement: Bounded disposable content retention
The system SHALL expire indexed preview and body content after a configurable age since refresh (365 days by default). It SHALL evict the oldest content until each account fits its configurable UTF-8 content budget (64 MiB by default). It SHALL enforce retention after indexing and during background maintenance, even when no provider work succeeds.

#### Scenario: Age and budget exceeded
- **WHEN** previews exceed their configured age or account budget
- **THEN** eligible preview text is cleared and those messages remain navigable with the same identity and flags

#### Scenario: Account isolation
- **WHEN** retention runs for one tenant and account
- **THEN** content belonging to other tenants or accounts is unchanged

#### Scenario: Year-old body
- **WHEN** a message's body text was indexed 300 days ago and its account is within budget
- **THEN** searching a word from its body still finds it under the default policy
