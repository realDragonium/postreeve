# Tasks
- [x] 1. Persist and derive sanitized synchronization health and recovery behavior.
- [x] 2. Enforce configurable preview retention without removing indexed metadata.
- [x] 3. Expose health, retry and human reauthorization in API, UI and WebMCP.
- [x] 4. Verify deterministic contracts and browser workflow; update documentation and archive specs.

Verification: `bun run verify` passed after integrating Gmail 93441b9 and IMAP 18cf778 (406 tests, strict TypeScript, production build). Focused tests cover byte accounting across merge/restart, retention isolation, authentication pause, retry and discovery-only failure preservation. T3 browser fixture exercised Settings → Sync & storage, degraded state, safe retry to healthy, reauthorization-required state and human Manage account form. No credentials entered or provider mail contacted. Independent review and Linear verification are coordinated by the parent separately.

Review repairs preserve missing global-key validation, failure/last-success evidence through verified credential replacement, and startup registration recovery without reviving intentionally canceled or authentication-paused jobs. In-memory service tests exercise each path. WebMCP coverage documents recovery as human guidance rather than automated Google consent.
