# Design

## Layout

The tailnet carries the UI and `/api` through `tailscale serve`, which forwards the Tailscale IP's port 443 to `127.0.0.1:3000`. The public IP carries Caddy on 80/443 and the mail ports. Port 3000 is never named in Caddy. The public MCP endpoints go to a separate loopback port, so the boundary is a different socket rather than a header or Host check.

`tailscale serve` and Caddy can both use 443. Tailscale's netstack intercepts tailnet TCP on serve ports before the host stack sees it. The self-connection listener caveat and the 8443 fallback are documented, because this was read from source and not tested on the host.

## poste.io now, rather than waiting for Stalwart

Decision: document poste.io behind Caddy now, instead of enabling public MCP only after the Stalwart cutover. It gives the single public TLS front immediately and is the same shape Stalwart will need. poste.io's documented variables are `HTTPS=OFF` and `HTTP_PORT`/`HTTPS_PORT`. Its IMAP/SMTP certificate still renews by HTTP-01, so for `mail.<domain>` the design is:
- Caddy passes `/.well-known/acme-challenge/*` on port 80 through to poste.io;
- Caddy proves its own certificate for that name with TLS-ALPN-01 (`disable_http_challenge`).

Both get certificates for the same name without fighting over port 80. The guide tells the owner to check the variable names against their poste.io version. Waiting for the cutover remains possible by simply leaving the `mcp.<domain>` block out.

Both Caddyfile snippets were checked with `caddy adapt` on Caddy v2.11.7.

## Stalwart routes

Only JMAP discovery and API, autoconfig/autodiscover and the MTA-STS policy are forwarded publicly; everything else on Stalwart's HTTP listener, including its admin UI, gets 404 from Caddy and is reached over the tailnet. `feat/stalwart-admin` owns the exact paths and ports; the guide marks them as placeholders.

## X-Forwarded-For

Caddy 2.5+ trusts no proxies by default, so it discards client `X-Forwarded-*` and sets `X-Forwarded-For` to the socket peer. The last entry is the real client, matching `feat/remote-mcp`'s rate-limit key. `trusted_proxies` is documented only for a CDN, never `0.0.0.0/0`.

## Firewall

ufw denies by default and allows 22 (removed once SSH over the tailnet works), 80/443, the mail ports, Tailscale's UDP port and everything on `tailscale0`. Docker's iptables rules run before ufw. So every non-mail container port must publish on `127.0.0.1`, and the guide adds an outside `nmap` check.

## Not wired here

The public listener is out of this branch: this session's permission policy blocked it, and the owner directed it be done at integration. Remaining items are listed in the coordinator summary and in the guide's banner.
