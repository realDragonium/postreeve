## MODIFIED Requirements

### Requirement: Tailnet serving model
The documented hosted setup SHALL run Postreeve with Docker Compose, published only on the host's loopback, and SHALL reach it through the host's `tailscale serve` at `https://<machine>.<tailnet>.ts.net`, with `POSTREEVE_PUBLIC_URL` set to that origin and `POSTREEVE_TRUST_PROXY=1`. It SHALL state that owner login is required before serving it. It SHALL describe Tailscale Funnel only on a separate port that maps the Funnel public paths and nothing else, keeping the web UI and `/api` tailnet-only, and SHALL list the risks.

#### Scenario: Other tailnet device
- **WHEN** the owner opens the ts.net URL on a phone in the tailnet
- **THEN** the page loads over HTTPS and the server is not reachable on the machine's LAN address

## ADDED Requirements

### Requirement: Funnel requests reach only the public MCP paths
The server SHALL answer 404 `{ error: "Not found" }`, before any other handler, to a request carrying a `Tailscale-Funnel-Request` header unless its path is `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register` or `/oauth/token`, or a sub-path of one of them, and contains no `%` or `\`. Requests without the header SHALL pass unchanged. `/oauth/authorize` SHALL NOT be a Funnel public path.

#### Scenario: Connector calls MCP
- **WHEN** a Funnel request posts to `/mcp`
- **THEN** it reaches the MCP handler

#### Scenario: Internet request for the UI
- **WHEN** a Funnel request asks for `/`, `/api/accounts` or `/oauth/authorize`
- **THEN** the response is 404 and no other handler runs

#### Scenario: Tailnet request
- **WHEN** a request through `tailscale serve` on the tailnet asks for `/api/accounts`
- **THEN** the guard does not affect it
