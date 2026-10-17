# Design

## Context

Deployment: loopback server behind `tailscale serve`; Funnel exposes `/mcp`, `/.well-known/oauth-protected-resource` (and its `/mcp` suffix), `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`. `/oauth/authorize` stays tailnet-only: the owner's browser opens it, and the connector only needs the redirect back to its own callback plus a server-to-server call to `/oauth/token`.

## Decisions

- **In-memory fixed-window counters.** One process serves one owner; a restart resetting counters is harmless. A shared store would add a dependency for nothing.
- **Last `X-Forwarded-For` entry as the address.** Behind one trusted proxy the last entry is the one the proxy added; the first can be forged by the client. Without the header (loopback, tests) all callers share the `direct` bucket.
- **Per-token limit for authenticated `/mcp`.** A busy legitimate agent should not starve another, and a leaked token is capped regardless of address.
- **Tool error messages stay visible to authenticated agents.** Agents need validation and "account not available" messages to recover. Only unexpected failures outside tool execution become a generic `server_error`.

## Risks / Trade-offs

- [Counters are per process] → acceptable for a single home server.
- [Legitimate burst from claude.ai refreshing tools] → 120 per minute per token is far above observed connector traffic.
