# Spec Delta

## MODIFIED Requirements

### Requirement: Protected resource metadata
The server SHALL answer `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` with RFC 9728 metadata: `resource`, `authorization_servers` holding the issuer, `scopes_supported` (`mail:read`, `mail:propose`, `mail:draft`, `mail:act`), `bearer_methods_supported: ["header"]` and `resource_name`.

#### Scenario: Discover the authorization server
- **WHEN** a client requests the path-suffixed metadata
- **THEN** it receives the resource `<origin>/mcp` and the issuer in `authorization_servers`

### Requirement: Consent requires the signed-in owner
The authorize page SHALL be shown only to a signed-in owner session; without one it SHALL ask the person to sign in and reload, and grant nothing. The consent page SHALL show the client name, redirect host, a tier (Read only; Read and prepare, which adds proposals and drafts; Read, prepare and act; defaulting to the requested scope or Read and prepare) and the accounts. It SHALL say that agents can never send mail or approve proposals.

#### Scenario: Not signed in
- **WHEN** a browser without an owner session opens a valid authorize URL
- **THEN** the page asks to sign in and no code is issued

#### Scenario: Prepare tier
- **WHEN** the owner allows Read and prepare
- **THEN** tokens carry `mail:read mail:propose mail:draft`
