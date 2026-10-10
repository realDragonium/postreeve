# Tasks
## 1. Contract and providers
- [x] 1.1 Add `flag` and `unflag` to the shared action type and `previousFlagged` to applied undo data.
- [x] 1.2 Apply and undo flags in the IMAP (`\Flagged`) and Gmail (`STARRED`) providers and the test mail double; cover with provider tests.
## 2. Core and index
- [x] 2.1 Pass confirmed flag state through core apply/undo into the synchronization index, including Gmail all-location updates; test flagged filter after apply and undo.
## 3. Interfaces
- [x] 3.1 Accept `flag`/`unflag` in WebMCP `apply_message_actions`; test.
- [x] 3.2 UI: reader chip, list Flag/Unflag, `s` shortcut, row flag mark, status labels, Activity labels, hint bar.
- [x] 3.3 Update FEATURES.md.
## 4. Verification
- [x] 4.1 Run typecheck, tests, build, e2e when a browser is available, and strict OpenSpec validation.
