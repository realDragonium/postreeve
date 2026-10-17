# Spec Delta

## MODIFIED Requirements

### Requirement: Public origin
The server SHALL use the origin of `POSTREEVE_MCP_PUBLIC_URL`, or of `POSTREEVE_PUBLIC_URL` when it is unset, or else of the request, as the OAuth issuer, as the protected resource `<origin>/mcp` and for the registration, token and revocation endpoints. `authorization_endpoint` and the consent form's same-origin check SHALL use the origin of `POSTREEVE_PUBLIC_URL`, or else of the request.

#### Scenario: Hosted origin
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://mail.example.com/` and metadata is requested
- **THEN** the issuer is `https://mail.example.com` and the resource is `https://mail.example.com/mcp`

#### Scenario: Separate agent origin
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://box.tail.ts.net` and `POSTREEVE_MCP_PUBLIC_URL` is `https://box.tail.ts.net:8443`
- **THEN** the issuer and resource use `:8443` and `authorization_endpoint` is `https://box.tail.ts.net/oauth/authorize`
