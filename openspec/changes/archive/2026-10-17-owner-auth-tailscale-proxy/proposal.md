# Proposal

## Why

The deploy target moved from Fly.io to the owner's always-on home machine on a Tailscale tailnet. `tailscale serve` terminates HTTPS at `https://<machine>.<tailnet>.ts.net` and proxies to Postreeve on `127.0.0.1`. The owner-auth change trusted Fly-specific headers and read the first `X-Forwarded-For` entry, and it ignored `X-Forwarded-Host`, so passkeys, Secure cookies and the origin check would key off `127.0.0.1` if the proxy rewrote `Host`.

## What Changes

- With `POSTREEVE_TRUST_PROXY`, the server reads `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`, taking the rightmost value (the one the nearest proxy set). `Fly-Forwarded-Proto` and `Fly-Client-IP` are no longer read.
- The browser-facing host is `X-Forwarded-Host` from a trusted proxy, else `Host`. It decides the public-URL match, the expected `Origin`, the WebAuthn RP and Secure cookies.
- The host check requires both `Host` and a trusted `X-Forwarded-Host` to be allowed, so a DNS-rebinding page that adds the header still fails on `Host`.
- Tailscale identity headers (`Tailscale-User-Login` and others) are never authentication: anything else that reaches the port can send them.
- Owner login stays as specified, as defense in depth and for parts that Tailscale Funnel may later expose.

## Capabilities

### Modified Capabilities

- `runtime/local-server`: allowed hosts and cross-site write rejection use the forwarded host and scheme.
- `runtime/owner-auth`: session cookie security, passkey RP and the rate-limit client key use the forwarded headers; identity headers are excluded.

## Impact

`src/server/security/request-context.ts`, `request-origin.ts`, `app.ts`, tests, README. No storage or UI change.
