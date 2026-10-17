# Proposal

## Why

The owner decided to let cloud MCP connectors (claude.ai, ChatGPT) reach Postreeve's remote MCP server through Tailscale Funnel. These connectors run outside the tailnet. The web UI and `/api` must stay tailnet-only, and a mistake in the Funnel path mapping must not expose them. The owner also chose Docker Compose on Linux as the primary run mode.

## What Changes

- New module `src/server/runtime/funnel-paths.ts` with the public-path allowlist (`/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token`, each with sub-paths) and a middleware that answers 404 to any request carrying `Tailscale-Funnel-Request` for another path, or for a path with `%` or `\`.
- The middleware runs on every request, before the host check.
- `/oauth/authorize` stays tailnet-only. The consent page needs the owner's login, so the remote MCP server advertises it on the tailnet origin, and the owner's browser must be on the tailnet.
- `docs/self-host-tailscale.md` is restructured around Docker Compose with host `tailscale serve`. It gains a concrete Funnel setup on port 8443, and the systemd service moves to an appendix.
- WebMCP: no changes.

## Capabilities

### Modified Capabilities

- `runtime/self-hosting`: the serving model now includes the Funnel allowlist and Compose as the primary path; new requirement for Funnel request filtering.

## Impact

- `src/server/runtime/funnel-paths.ts`, `src/server/index.ts`, `tests/funnel-paths.test.ts`, `docs/self-host-tailscale.md`.
- `feat/remote-mcp` must serve its endpoints at these paths, or update the list in the same change.
