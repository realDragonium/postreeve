# Tasks

- [x] 1.1 Add `/oauth/revoke`, return a bare 404 and document why the header is honored without `TRUST_PROXY`; verify with `tests/funnel-paths.test.ts`.
- [x] 1.2 Read `X-Forwarded-For` and serve-port interception in Tailscale's source and document the findings.
- [x] 2.1 Add the same-host mail-server section and update the Funnel steps in `docs/self-host-tailscale.md`.
- [x] 2.2 Delta spec; run `bun run verify` and `bunx openspec validate --specs --strict`.
