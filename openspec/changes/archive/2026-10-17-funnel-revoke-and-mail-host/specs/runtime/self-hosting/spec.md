## MODIFIED Requirements

### Requirement: Funnel requests reach only the public MCP paths
The server SHALL answer a bare 404 with no body, before any other handler, to a request carrying a `Tailscale-Funnel-Request` header unless its path is `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` or `/oauth/revoke`, or a sub-path of one of them, and contains no `%` or `\`. It SHALL apply this whether or not `POSTREEVE_TRUST_PROXY` is set. Requests without the header SHALL pass unchanged. `/oauth/authorize` SHALL NOT be a Funnel public path.

#### Scenario: Connector calls MCP
- **WHEN** a Funnel request posts to `/mcp`
- **THEN** it reaches the MCP handler

#### Scenario: Connector reads resource metadata
- **WHEN** a Funnel request asks for `/.well-known/oauth-protected-resource/mcp`
- **THEN** it reaches the metadata handler

#### Scenario: Connector revokes a token
- **WHEN** a Funnel request posts to `/oauth/revoke`
- **THEN** it reaches the revocation handler

#### Scenario: Internet request for the UI
- **WHEN** a Funnel request asks for `/`, `/api/accounts` or `/oauth/authorize`
- **THEN** the response is 404 with an empty body and no other handler runs

#### Scenario: Tailnet request
- **WHEN** a request through `tailscale serve` on the tailnet asks for `/api/accounts`
- **THEN** the guard does not affect it

## ADDED Requirements

### Requirement: Same-host mail server guidance
The self-hosting guide SHALL explain running next to a mail server that publishes 443 and the mail ports: whether `tailscale serve` on 443 coexists with it, a fallback HTTPS port when it does not, keeping separate Docker networks, connecting to the mail server by its public hostname, and backing up off the machine.

#### Scenario: poste.io on the same VPS
- **WHEN** the owner follows the guide on a VPS where poste.io publishes `0.0.0.0:443`
- **THEN** tailnet devices reach Postreeve at the ts.net URL, the public IP still reaches poste.io, and the guide gives the 8443 fallback if that check fails
