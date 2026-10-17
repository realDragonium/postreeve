# Design

## Funnel detection

Tailscale's serve proxy (`ipn/ipnlocal/serve.go`, `addTailscaleIdentityHeaders`) deletes any client-sent `Tailscale-Funnel-Request` header and sets it to `?1` when the connection arrived through Funnel. Funnel requests also get no `Tailscale-User-*` identity headers. The header is therefore a reliable marker: the internet cannot forge it or strip it. A tailnet or loopback client can add it, but that only restricts itself.

## Two layers

1. Tailscale maps only the public paths on a separate Funnel port (8443). Port 443 stays a tailnet-only `tailscale serve` of the whole app. Funnel exposes everything served on a port, so the separate port is what keeps the UI off the internet.
2. Postreeve's `funnelPathGuard` answers 404 to Funnel requests outside the allowlist. This protects against a wrong `tailscale funnel` command, such as funneling port 443 or mapping `/` to the backend.

A separate listener inside Postreeve was rejected. It would add a second port, a second host-check configuration and a second Docker publish, and the header check gives the same guarantee with one middleware.

## Path handling

Bun resolves `..` and `.` segments, including `%2e%2e` and backslash forms, before handlers see the URL. This was checked with raw HTTP requests: `/mcp/../api/accounts` arrives as `/api/accounts`. So the guard and Hono's router see the same path. The guard still refuses `%` and `\` in Funnel paths, so no later layer can decode a path different from the one checked. MCP and the OAuth endpoints use no encoded path characters. Matching is case-sensitive, like the router.

## The allowlist

`/mcp`, `/.well-known/oauth-protected-resource` (sub-paths cover the RFC 9728 path-suffixed form `/.well-known/oauth-protected-resource/mcp`), `/.well-known/oauth-authorization-server`, `/oauth/register` and `/oauth/token`. These are the calls a cloud connector makes from its own servers.

`/oauth/authorize` is excluded on purpose. It renders the consent page, which needs the owner's session and the login endpoints under `/api`. Exposing it would mean exposing login to the internet. Instead, the authorization server metadata advertises `authorization_endpoint` on `POSTREEVE_PUBLIC_URL` (tailnet), and the owner opens it in a browser on a tailnet device. RFC 8414 allows endpoints on a different host than the issuer. The coordinator suggested including `/oauth/*`; narrowing it to register and token is the safer reading of "the web UI stays tailnet-only", and the remote MCP workstream has been told.

The guard lives in `src/server/runtime/`, not `src/server/security/`, because `feat/owner-auth` owns the security modules.

## Compose first

The owner's machine is Linux with Docker, so the guide leads with Compose and the host's existing `tailscaled`. A `tailscale/tailscale` sidecar with `TS_SERVE_CONFIG` was considered and rejected as the default: it adds a second tailnet node with its own auth key and name, and the host is already on the tailnet. systemd stays as a short appendix.
