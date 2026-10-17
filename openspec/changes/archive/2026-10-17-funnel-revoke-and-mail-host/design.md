# Design

## Header honored without TRUST_PROXY

The coordinator suggested ignoring `Tailscale-Funnel-Request` unless `POSTREEVE_TRUST_PROXY=1`. I did not, for two reasons. The header can only narrow what a request may reach, never widen it, so a client that sends it on purpose only locks itself out. And tailscaled deletes any client copy before setting its own, so it cannot be forged. Gating it on `TRUST_PROXY` would make a missing setting fail open: Funnel would publish the UI. Enforcing it always fails closed.

## X-Forwarded-For

From `ipn/ipnlocal/serve.go`: the proxy is `httputil.ReverseProxy{Rewrite: ...}`. Since Go 1.20, `ReverseProxy` removes inbound `Forwarded` and `X-Forwarded-*` headers before calling `Rewrite`. `addProxyForwardedHeaders` then calls `Header.Set("X-Forwarded-For", c.SrcAddr.Addr().String())`. For Funnel, `HandleIngressTCPConn` documents that `srcAddr` is the original client, not the ingress peer. So Postreeve sees exactly one `X-Forwarded-For` value, chosen by Tailscale, and a "last entry with one trusted proxy" rate-limit key is correct. The exception is direct loopback access, which only host processes have. This is recorded in the guide for `feat/remote-mcp`.

## Port 443 next to poste.io

`wgengine/netstack` intercepts inbound TCP to the node's Tailscale IPs on serve ports (`ShouldInterceptTCPPort`) and drops the packet from the host stack. The decision depends on the serve configuration, not on OS sockets. Tailnet traffic to 443 therefore reaches serve even with poste.io on `0.0.0.0:443`. Public traffic is untouched. `ipnlocal` also opens a host listener on the Tailscale IP for self-connections, which can collide. The guide states this from source reading and gives the 8443 fallback. It was not tested on a poste.io host.

## Connecting to poste.io

Use the public hostname, so the Let's Encrypt certificate validates and accounts survive a move. The guide covers hairpin NAT with an `extra_hosts` host-gateway fallback, and says not to share Docker networks between the two stacks.
