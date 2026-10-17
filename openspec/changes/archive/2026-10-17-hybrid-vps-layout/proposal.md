# Proposal

## Why

The host turned out to be a Contabo VPS with a public IP, not yet on Tailscale, running poste.io (Stalwart later). The owner chose a hybrid layout:
- the Postreeve UI and `/api` reachable only from the tailnet, through `tailscale serve`;
- the internet reaching only the mail ports, plus the remote MCP endpoints on `https://mcp.<domain>` through Caddy with Let's Encrypt.

Funnel adds nothing on a public IP and is dropped from the documented setup.

## What Changes

- `docs/self-host-tailscale.md` becomes `docs/self-host.md`. It covers:
  - installing Tailscale on the VPS (MagicDNS, HTTPS certificates, key expiry);
  - `tailscale serve` for the UI, and how it coexists with Caddy on 443;
  - Caddy as the single public TLS front;
  - poste.io behind Caddy (`HTTPS=OFF`, `HTTP_PORT`/`HTTPS_PORT`, ACME pass-through);
  - the Stalwart public routes;
  - Caddy's `X-Forwarded-For` behaviour;
  - a ufw firewall, with the warning that Docker-published ports bypass ufw;
  - connecting to the mail server by its public hostname;
  - required off-machine backups.
- The public MCP listener (`POSTREEVE_PUBLIC_MCP_PORT`, `POSTREEVE_MCP_PUBLIC_URL`) is documented as agreed but is **not wired in this branch**. The permission policy of this session blocked that change, and the owner directed it be wired at integration with `feat/remote-mcp` (`createPublicAgentAccess`).
- No code changes. The Funnel header guard stays as a harmless extra check.
- WebMCP: no changes.

## Capabilities

### Modified Capabilities

- `runtime/self-hosting`: the serving model describes the hybrid layout; the Funnel documentation requirement is removed; the mail-server guidance covers Caddy, poste.io, Stalwart and the firewall.

## Impact

- `docs/self-host.md`, `README.md`, path references in `compose.yaml` and `deploy/`.
