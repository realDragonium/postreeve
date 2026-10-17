# Proposal

## Why

On the owner's home server, Tailscale Funnel exposes the agent endpoints on their own origin (`https://<machine>.<tailnet>.ts.net:8443`) while the UI and consent page stay on the tailnet-only origin. RFC 8414 requires the issuer to equal the origin its metadata is fetched from, and the token audience must be the URL agents call, so one public origin no longer fits.

## What Changes

- New env `POSTREEVE_MCP_PUBLIC_URL`, defaulting to `POSTREEVE_PUBLIC_URL`. It sets the OAuth issuer, the protected resource `<origin>/mcp`, the registration, token and revocation endpoints, the `iss` redirect parameter and the `/mcp` audience check.
- `authorization_endpoint` and the consent form's same-origin check use `POSTREEVE_PUBLIC_URL`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `agents/agent-authorization`: the public origin splits into a UI origin and an agent origin.

## Impact

- `src/server/agent-access/oauth.ts`, `index.ts`, `src/server/index.ts`, README.md. No data change.
