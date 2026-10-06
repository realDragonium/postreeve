# Tasks

## 1. Gmail ingestion
- [x] 1.1 Implement account history, bounded repair and label reconciliation; verify deterministic adapter fixtures including duplicate, interruption, cancellation and fanout cases.
- [x] 1.2 Verify canonical and conversation identity underlying local workflow references through the ingestion path with deterministic fixtures and document Gmail synchronization behavior.

## 2. Integration
- [x] 2.1 Run strict typecheck, full tests, production build and OpenSpec validation.

## 3. Review repairs
- [x] 3.1 Reject incomplete metadata without index/checkpoint mutation; verify the real adapter and runner fixture.
- [x] 3.2 Persist a bounded repair restart budget; verify 400/404 rejection, resumed runner, failure and recovery fixtures.
- [x] 3.3 Bound expanded page bytes without trimming identity; verify large-label fanout and unrepresentable-single-observation fixtures.
- [x] 3.4 Verify multi-message history continuation through interrupted label fanout and newer history arrivals.

## Workflow follow-up
- Independently review and verify the Linear criteria.
- Archive and sync specs before integration into main.
