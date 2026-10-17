# Proposal

## Why

`feat/remote-mcp` finalized its public paths and added `/oauth/revoke`. The owner confirmed that Postreeve shares a Contabo VPS with poste.io (and later Stalwart), which publish the mail ports and 443 on all interfaces. The guide must explain how the two coexist.

## What Changes

- `/oauth/revoke` joins `FUNNEL_PUBLIC_PATHS`. `/.well-known/oauth-protected-resource/mcp` stays covered as a sub-path.
- Refused Funnel requests get a bare 404 with no body.
- The guard honors `Tailscale-Funnel-Request` whether or not `POSTREEVE_TRUST_PROXY` is set.
- The guide documents what `tailscale serve` and Funnel send in `X-Forwarded-For` (one address, set by Tailscale; client values are dropped).
- The guide gains a "Same host as a mail server" section: 443 coexistence, the 8443 fallback, separate Docker networks, connecting by the public hostname, and off-machine backups.
- WebMCP: no changes.

## Capabilities

### Modified Capabilities

- `runtime/self-hosting`: Funnel allowlist adds `/oauth/revoke` and a bare 404; new requirement for the same-host mail-server guidance.

## Impact

- `src/server/runtime/funnel-paths.ts`, `tests/funnel-paths.test.ts`, `docs/self-host-tailscale.md`.
