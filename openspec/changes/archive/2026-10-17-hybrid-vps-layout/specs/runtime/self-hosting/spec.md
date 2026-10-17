## MODIFIED Requirements

### Requirement: Tailnet serving model
The documented hosted setup SHALL run Postreeve with Docker Compose published only on the host's loopback. It SHALL make the web UI and `/api` reachable only from the tailnet through the host's `tailscale serve` at `https://<machine>.<tailnet>.ts.net`, with `POSTREEVE_PUBLIC_URL` set to that origin and `POSTREEVE_TRUST_PROXY=1`. It SHALL describe installing Tailscale on the host and state that owner login is required before serving it. It SHALL route public traffic only through Caddy and SHALL never forward port 3000 to the internet.

#### Scenario: Other tailnet device
- **WHEN** the owner opens the ts.net URL on a phone in the tailnet
- **THEN** the page loads over HTTPS and the server is not reachable on the machine's public address

### Requirement: Same-host mail server guidance
The self-hosting guide SHALL explain running next to a mail server on a public-IP host: Caddy as the single public TLS front on 80 and 443, putting poste.io behind Caddy, the public routes for Stalwart, how `tailscale serve` on 443 coexists with Caddy and a fallback port if it does not, separate Docker networks, connecting to the mail server by its public hostname, and required off-machine backups.

#### Scenario: poste.io on the same VPS
- **WHEN** the owner follows the guide on a VPS where Caddy holds the public 443 and poste.io sits behind it
- **THEN** tailnet devices reach Postreeve at the ts.net URL, the public name reaches poste.io webmail, and the mail ports reach poste.io directly

## ADDED Requirements

### Requirement: Public front and firewall guidance
The guide SHALL document Caddy's `X-Forwarded-For` behavior (client values discarded unless `trusted_proxies` is set), a default-deny firewall that allows only SSH, 80, 443 and the mail ports from the internet, and that Docker-published ports bypass ufw so every non-mail container port publishes on `127.0.0.1`. It SHALL describe the public MCP listener (`POSTREEVE_PUBLIC_MCP_PORT`, `POSTREEVE_MCP_PUBLIC_URL`) behind `mcp.<domain>` and mark it as not yet available until it is wired.

#### Scenario: Port scan from outside
- **WHEN** the owner scans the VPS's public IP after following the guide
- **THEN** only 22 (until moved to the tailnet), 25, 80, 443, 465, 587 and 993 are open

## REMOVED Requirements

### Requirement: Funnel is documented on a separate port
**Reason**: The host has a public IP and Caddy; Funnel adds nothing, and the owner dropped it.
**Migration**: Publish the remote MCP endpoints on `mcp.<domain>` through Caddy and the public MCP listener.
