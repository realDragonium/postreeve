# agents/agent-authorization Specification

## Purpose
Covers how the owner authorizes agents to use remote MCP: the OAuth 2.1 authorization server Postreeve runs for itself, the consent page, scopes and account restriction, token lifecycle, personal access tokens and the Connected agents settings.

## Requirements

### Requirement: Public origin
The server SHALL use the origin of `POSTREEVE_MCP_PUBLIC_URL`, or of `POSTREEVE_PUBLIC_URL` when it is unset, or else of the request, as the OAuth issuer, as the protected resource `<origin>/mcp` and for the registration, token and revocation endpoints. `authorization_endpoint` and the consent form's same-origin check SHALL use the origin of `POSTREEVE_PUBLIC_URL`, or else of the request.

#### Scenario: Hosted origin
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://mail.example.com/` and metadata is requested
- **THEN** the issuer is `https://mail.example.com` and the resource is `https://mail.example.com/mcp`

#### Scenario: Separate agent origin
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://box.tail.ts.net` and `POSTREEVE_MCP_PUBLIC_URL` is `https://box.tail.ts.net:8443`
- **THEN** the issuer and resource use `:8443` and `authorization_endpoint` is `https://box.tail.ts.net/oauth/authorize`

### Requirement: Protected resource metadata
The server SHALL answer `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` with RFC 9728 metadata: `resource`, `authorization_servers` holding the issuer, `scopes_supported` (`mail:read`, `mail:propose`, `mail:draft`, `mail:act`), `bearer_methods_supported: ["header"]` and `resource_name`.

#### Scenario: Discover the authorization server
- **WHEN** a client requests the path-suffixed metadata
- **THEN** it receives the resource `<origin>/mcp` and the issuer in `authorization_servers`

### Requirement: Authorization server metadata
The server SHALL answer `GET /.well-known/oauth-authorization-server` with RFC 8414 metadata naming `authorization_endpoint` `/oauth/authorize`, `token_endpoint` `/oauth/token`, `registration_endpoint` `/oauth/register`, `revocation_endpoint` `/oauth/revoke`, response type `code`, grants `authorization_code` and `refresh_token`, PKCE method `S256` only, and client auth methods `none`, `client_secret_post` and `client_secret_basic`.

#### Scenario: PKCE methods
- **WHEN** a client reads the metadata
- **THEN** `code_challenge_methods_supported` is `["S256"]`

### Requirement: Dynamic client registration
`POST /oauth/register` SHALL accept RFC 7591 JSON with `client_name` (1 to 100 characters, default `Unnamed agent`), 1 to 10 `redirect_uris` and an optional `token_endpoint_auth_method`, and answer 201 with `client_id`, the registered metadata and, for a confidential method, a `client_secret` shown only once. A redirect URI SHALL be `https`, or `http` on a loopback host; anything else SHALL be refused with 400 `invalid_redirect_uri`. Registration SHALL grant no access.

#### Scenario: Public client
- **WHEN** a client registers with `token_endpoint_auth_method: "none"` and `https://claude.ai/api/mcp/auth_callback`
- **THEN** the response is 201 with a `client_id` and no `client_secret`

#### Scenario: Plain HTTP redirect
- **WHEN** a client registers `http://evil.example/cb`
- **THEN** the response is 400 `invalid_redirect_uri`

### Requirement: Authorize validates before consent
`GET /oauth/authorize` SHALL require `response_type=code`, a registered `client_id`, a `redirect_uri` exactly matching a registered one (a loopback URI may differ in port), `code_challenge` with `code_challenge_method=S256`, and a `resource` equal to `<origin>/mcp` or `<origin>` when present. An unknown client or redirect URI SHALL show an error page and never redirect; other invalid requests SHALL redirect with `error` and `state`.

#### Scenario: Missing PKCE
- **WHEN** a registered client requests authorization without `code_challenge`
- **THEN** the browser is redirected to its `redirect_uri` with `error=invalid_request` and the original `state`

#### Scenario: Unregistered redirect
- **WHEN** the `redirect_uri` is not registered for the client
- **THEN** an error page is shown and no redirect happens

### Requirement: Consent requires the signed-in owner
The authorize page SHALL be shown only to a signed-in owner session; without one it SHALL ask the person to sign in and reload, and grant nothing. The consent page SHALL show the client name, redirect host, a tier (Read only; Read and prepare, which adds proposals and drafts; Read, prepare and act; defaulting to the requested scope or Read and prepare) and the accounts. It SHALL say that agents can never send mail or approve proposals.

#### Scenario: Not signed in
- **WHEN** a browser without an owner session opens a valid authorize URL
- **THEN** the page asks to sign in and no code is issued

#### Scenario: Prepare tier
- **WHEN** the owner allows Read and prepare
- **THEN** tokens carry `mail:read mail:propose mail:draft`

### Requirement: Consent decision
The consent form SHALL post to `/oauth/authorize` with a single-use pending request ID valid for 10 minutes, SHALL require an owner session and a same-origin `Origin` when present, and SHALL either redirect with `error=access_denied` or create a grant and redirect with a single-use code valid for 5 minutes and the original `state`.

#### Scenario: Owner allows read only for one account
- **WHEN** the owner chooses Read only and account A and allows
- **THEN** the client is redirected with a `code`, and tokens from it carry `mail:read` restricted to account A

#### Scenario: Owner denies
- **WHEN** the owner selects Deny
- **THEN** the client is redirected with `error=access_denied` and no grant exists

### Requirement: Code exchange with PKCE
`POST /oauth/token` with `grant_type=authorization_code` SHALL require the code, the same `redirect_uri` and `client_id`, client authentication for confidential clients, and a `code_verifier` whose S256 hash equals the challenge. It SHALL answer with `access_token` (valid 1 hour), `refresh_token`, `token_type: "Bearer"`, `expires_in` and `scope`, with `Cache-Control: no-store`. A second use of a code SHALL fail with `invalid_grant` and revoke the grant's tokens.

#### Scenario: Wrong verifier
- **WHEN** a client exchanges a code with a verifier that does not match the challenge
- **THEN** the response is 400 `invalid_grant` and no token is issued

#### Scenario: Code replay
- **WHEN** a code that was already exchanged is presented again
- **THEN** the response is 400 `invalid_grant` and the tokens issued from it stop working

### Requirement: Refresh token rotation
`grant_type=refresh_token` SHALL issue a new access token and a new refresh token, revoke the presented refresh token, and allow narrowing but not widening the scope. A refresh token is valid 30 days from issue. Presenting a rotated refresh token SHALL fail with `invalid_grant`, and more than 30 seconds after its rotation SHALL also revoke the whole grant.

#### Scenario: Rotate
- **WHEN** a client refreshes with its refresh token
- **THEN** it receives a new pair and the old refresh token no longer works

#### Scenario: Reuse detection
- **WHEN** an old, already-rotated refresh token is presented
- **THEN** the response is 400 `invalid_grant` and every token of that grant is revoked

### Requirement: Token revocation
`POST /oauth/revoke` SHALL accept `token` and answer 200 whether or not the token was known. Revoking a refresh token SHALL revoke its grant; revoking an access token SHALL revoke only that token.

#### Scenario: Client disconnects
- **WHEN** a client revokes its refresh token
- **THEN** its access token is rejected by `/mcp` with 401

### Requirement: Tokens are stored hashed
The server SHALL store only SHA-256 hashes of client secrets, codes, access tokens, refresh tokens and personal access tokens, and SHALL never return a stored secret again after issuing it.

#### Scenario: Database contents
- **WHEN** a token has been issued
- **THEN** the database holds its hash and not the token

### Requirement: Personal access tokens
The owner SHALL be able to create a personal access token from Settings with a name, a tier and accounts. The token SHALL be shown once, SHALL not expire, SHALL be usable as a bearer token at `/mcp`, and SHALL be listed and revoked like other grants.

#### Scenario: CLI agent
- **WHEN** the owner creates a read-only token named `laptop` and a CLI agent calls `/mcp` with it
- **THEN** the agent can list messages and cannot apply actions

### Requirement: Connected agents settings
Settings SHALL offer Connected agents, listing each active grant with its name, kind (`OAuth` or `Token`), tier, accounts, creation time and last use, with a Revoke button that ends the grant immediately. It SHALL show the `/mcp` URL to connect. Its API under `/api/agent-access` SHALL require the owner session.

#### Scenario: Revoke from settings
- **WHEN** the owner selects Revoke on an agent
- **THEN** it disappears from the list and its next `/mcp` call is answered with 401
