# Proposal

## Why

Agents can triage mail but cannot help write it: the only compose tool sends immediately, and remote agents cannot send at all. "Draft a reply for me to review" is the most common thing the owner wants from an agent. Proposals also dead-end: the person can accept one but not turn it down, so a bad proposal waits forever.

## What Changes

- New shared agent tools: `list_identities`, `list_signatures`, `list_drafts`, `read_draft`, `read_attachment`, `create_draft` and `update_draft`. Drafts can be new messages, replies, reply-alls or forwards, from an identity chosen by address. No tool sends a draft; the person sends it from Postreeve.
- New scope `mail:draft`, granted by the middle and top tiers. The middle tier is renamed **Read and prepare** (proposals and drafts).
- Proposals gain a `declined` status. The reader strip offers **Decline** beside Accept, through a new human-only `POST /api/proposals/<id>/decline`. No agent tool declines.
- FEATURES.md and README.md follow.

## Capabilities

### New Capabilities

### Modified Capabilities

- `agents/webmcp-tools`: seven new tools and their effects in Assistant control.
- `agents/remote-mcp`: draft tools under `mail:draft`; no tool sends a draft.
- `agents/agent-authorization`: `mail:draft` scope and the renamed tier.
- `actions/proposals`: `declined` status, decline endpoint and the reader's Decline control.

## Impact

- Shared contracts: `declined` proposal status.
- `src/server/webmcp/*`, `src/server/mcp/services.ts`, `src/web/webmcp.ts`, `src/shared/agent-access.ts`.
- Core service and `src/server/api.ts`: one decline route.
- Web: Reader strip Decline button and App mutation.
- No database migration; proposal status is free text.
