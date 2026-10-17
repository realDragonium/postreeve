# Design

## Rightmost forwarded value
`tailscale serve` uses Go's `httputil.ReverseProxy`, which with `Rewrite` strips inbound `X-Forwarded-*` before setting its own, and `SetXForwarded` appends the client address to `X-Forwarded-For`. The rightmost entry is therefore always the one the nearest trusted proxy wrote; earlier entries can be client-supplied. The server reads the rightmost entry for all three headers. Reading the first entry, as the owner-auth change did, would let a client choose its own rate-limit key.

## Forwarded host
`tailscale serve` keeps `Host` and also sets `X-Forwarded-Host`. Postreeve treats `X-Forwarded-Host` (when trusted) as the host the browser addressed, so a proxy that rewrites `Host` to `127.0.0.1:3000` still yields the ts.net origin, RP ID and Secure cookie. The host guard checks both names: a rebinding page on `attacker.example` can add `X-Forwarded-Host` but cannot change `Host`.

## No identity headers
Tailscale adds `Tailscale-User-Login` to tailnet requests, but any local process or other proxy that can reach `127.0.0.1:3000` can send the same header. Owner login stays the only authentication; the remote MCP and Funnel work keeps its own OAuth.

## Fly headers dropped
Postreeve no longer deploys on Fly. Keeping `Fly-Client-IP` would let any client behind a non-Fly proxy pick its rate-limit key, since nothing strips it.
