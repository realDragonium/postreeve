## ADDED Requirements

### Requirement: Account synchronization health
The system SHALL expose healthy, catching-up, degraded, disconnected and reauthorization-required account states from durable job evidence and provider availability. It SHALL retain the latest actionable classified failure and its time through retry until successful provider progress, without retaining provider error text, credentials or cursors in health responses. A provider registration failure SHALL leave other accounts usable. Global credential-vault validation SHALL remain enforced.

#### Scenario: Retry after a transient failure
- **WHEN** a person retries a degraded account
- **THEN** its current failure remains visible until a successful synchronization page clears it

#### Scenario: Authorization expired
- **WHEN** a provider reports authentication failure
- **THEN** health requires reauthorization and automatic retries pause until credentials are replaced or the person explicitly requests a retry

#### Scenario: Provider unavailable at startup
- **WHEN** one account cannot register its provider
- **THEN** that account is disconnected and other accounts can synchronize

### Requirement: Bounded disposable content retention
The system SHALL expire indexed preview content after a configurable age since refresh (30 days by default) and evict oldest content until each account fits its configurable UTF-8 content budget (100 MiB by default). It SHALL enforce retention after indexing and during background maintenance even when no provider work succeeds.

#### Scenario: Age and budget exceeded
- **WHEN** previews exceed their configured age or account budget
- **THEN** eligible preview text is cleared and those messages remain navigable with the same identity and flags

#### Scenario: Account isolation
- **WHEN** retention runs for one tenant and account
- **THEN** content belonging to other tenants or accounts is unchanged

### Requirement: Client synchronization recovery
The UI and agents SHALL inspect account health and retention policy, request safe synchronization retry, and request instructions for human reauthorization through existing Gmail OAuth or IMAP account settings. Health reads SHALL use local evidence and retry SHALL NOT change provider mail or grant an agent credentials or proposal approval.

#### Scenario: Inspect and recover
- **WHEN** a person opens Sync & storage or an agent inspects synchronization
- **THEN** each account shows state, current actionable failure, retry availability and retention policy
- **AND** reauthorization instructions direct the person to the existing authorization interface

### Requirement: Retention preserves navigation and identity
Retention SHALL preserve all indexed summary rows, canonical identities, mutable locations, conversation links, drafts and proposal metadata, and SHALL NOT change provider mail. The displayed policy SHALL distinguish disposable content bounds from retained navigation metadata and total database size.

#### Scenario: Preview expired for an active conversation
- **WHEN** a preview expires for an unread or flagged conversation
- **THEN** the same message remains navigable with unchanged identity, flags and workflow references
