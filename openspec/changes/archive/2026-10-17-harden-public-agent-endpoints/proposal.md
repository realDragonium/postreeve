# Proposal

## Why

The owner self-hosts Postreeve behind `tailscale serve` and exposes only the remote MCP and OAuth endpoints to the internet through Tailscale Funnel, so claude.ai and ChatGPT cloud connectors can reach them. Those endpoints then receive hostile internet traffic and need bounds that loopback never needed.

## What Changes

- Per-address and per-token rate limits on `/mcp`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`, answered with 429 and `Retry-After`.
- Request body size limits: 1 MiB on `/mcp`, 16 KiB on the OAuth endpoints, answered with 413.
- Unexpected failures on these endpoints answer a generic `server_error` without internal detail.
- FEATURES.md compose and drafts rows are corrected to match the specs (reply, reply all, forward, attachments and server drafts work).

## Capabilities

### New Capabilities

### Modified Capabilities

- `agents/remote-mcp`: adds bounds for internet-facing agent endpoints.

## Impact

- `src/server/agent-access/index.ts` and a new `src/server/agent-access/limits.ts`.
- No database change.
