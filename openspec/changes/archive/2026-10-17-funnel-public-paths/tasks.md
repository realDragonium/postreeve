# Tasks

- [x] 1.1 Add `src/server/runtime/funnel-paths.ts` and mount the guard before the host check in `index.ts`; verify with tests for allowed paths, refused UI/API/consent/encoded paths and non-Funnel requests.
- [x] 1.2 Confirm the header name and stripping behavior in Tailscale's source, and Bun's path normalization with raw requests.
- [x] 2.1 Restructure `docs/self-host-tailscale.md` around Compose and add the Funnel setup and risks; move systemd to an appendix.
- [x] 2.2 Delta spec for `runtime/self-hosting`; run `bun run verify` and `bunx openspec validate --specs --strict`.
