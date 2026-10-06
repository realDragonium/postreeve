# Proposal

## Why
DRA-486 makes durable synchronization failures visible and bounds disposable local content. Accounts must remain inspectable when a provider cannot connect.

## What Changes
- Derive five synchronization health states from durable account jobs with sanitized actionable failure evidence.
- Let people and agents inspect health, request safe retries, and request human reauthorization instructions.
- Expire cached previews after 30 days since refresh or above 100 MiB per account by default, configurable on the server. Retain all navigation, canonical identity, location, conversation and proposal metadata.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `mailbox/synchronization`: Health evidence, recovery and bounded content retention.
- `agents/webmcp-tools`: Inspection, retry and human reauthorization tools.

## Impact
SQLite sync jobs/index, runner, service/API, Settings UI, WebMCP contracts and deterministic tests. No live mail changes, new attention system, body cache or provider-data deletion. Existing project implementation authorization covers applying this proposal and direct main integration.
