# Proposal

## Why

The owner runs Postreeve on a public-IP VPS. Caddy publishes a second loopback listener carrying only the agent endpoints at `POSTREEVE_MCP_PUBLIC_URL`, while the UI and consent page stay tailnet-only. The agent routes must be mountable on that listener without the consent page or owner API, and client addresses must not be taken from headers a direct caller can forge.

## What Changes

- A public-only agent router: OAuth metadata, `/oauth/register`, `/oauth/token`, `/oauth/revoke` and `/mcp`, without `/oauth/authorize` or `/api/agent-access`. Both listeners share rate-limit counters.
- The rate-limit address comes from the last `X-Forwarded-For` entry only when the TCP peer is loopback (the proxy); otherwise the peer address is used.

## Capabilities

### New Capabilities

### Modified Capabilities

- `agents/remote-mcp`: the public listener's route set and how the client address is chosen.

## Impact

- `src/server/agent-access/index.ts`, `oauth.ts`, `limits.ts`. The coordinator wires the second listener (`POSTREEVE_PUBLIC_MCP_PORT`) at merge.
