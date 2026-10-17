# Tasks

## 1. Server

- [x] 1.1 Add `googleRedirectUri` (public origin, loopback, `POSTREEVE_GOOGLE_REDIRECT`) and use it in `index.ts`; verify with tests for both modes, invalid URLs and a hosted PKCE flow with a fake Google.
- [x] 1.2 Add `createShutdown` and a shutdown signal that ends event streams; wire SIGTERM/SIGINT; verify with ordering, timeout and stream tests and a `docker stop` with an open event stream.
- [x] 1.3 Add `src/server/runtime/backup.ts`, `scripts/backup.ts` and `bun run backup`; schedule snapshots in `index.ts`; set `busy_timeout`; verify with snapshot, rotation, restore, invalid-file and schedule tests.

## 2. Packaging

- [x] 2.1 Harden the Dockerfile, add the entrypoint and `.dockerignore`; verify with `docker build`, health, host check, non-root uid, backup, graceful stop and restore in a container, and entrypoint tests with stubbed commands.
- [x] 2.2 Update `compose.yaml`; verify with `docker compose config`.
- [x] 2.3 Add the systemd unit and launchd plist; verify with `systemd-analyze verify` and a plist parse.
- [x] 2.4 Add the CI workflow.

## 3. Documentation and specs

- [x] 3.1 Write `docs/self-host-tailscale.md` and link it from README.
- [x] 3.2 Delta specs for `runtime/local-server`, `accounts/gmail-accounts` and new `runtime/self-hosting`; verify with `bunx openspec validate --strict`.
- [x] 3.3 Run `bun run verify`.
