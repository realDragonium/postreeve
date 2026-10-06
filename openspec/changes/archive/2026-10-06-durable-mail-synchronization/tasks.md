# Tasks

## 1. Index and ingestion
- [x] 1.1 Persist summaries, scoped cursors and atomic repair evidence; verify duplicate, merge, partial failure and boundary cases with deterministic store tests.
- [x] 1.2 Document provider page limits and snapshot semantics; verify contract with deterministic scoped adapters.

## 2. Durable runner
- [x] 2.1 Wire account and server lifecycle to restartable jobs; verify retry, restart, timeout, cancellation, replacement and disconnect through the runner and service.

## 3. Integration
- [x] 3.1 Run full repository verification and strict OpenSpec validation; inspect the complete diff before handoff.

## Workflow follow-up
- Archive and synchronize specs after implementation checks.
- Independent review and verifier gate direct delivery to main; only verifier checks Linear Todo.
