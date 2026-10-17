# Spec Delta

## ADDED Requirements

### Requirement: Public listener serves only agent endpoints
The router for the public listener SHALL serve only `/mcp`, `/.well-known/oauth-protected-resource` (and `/mcp` beneath it), `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`, and SHALL answer 404 for `/oauth/authorize`, `/api/*` and every other path. Rate-limit counters SHALL be shared with the private listener of the same server.

#### Scenario: Consent page on the public listener
- **WHEN** a client requests `/oauth/authorize` on the public listener
- **THEN** the response is 404

#### Scenario: Limits span listeners
- **WHEN** one address registers five clients on each listener within an hour and then once more
- **THEN** the last registration is answered with 429

## MODIFIED Requirements

### Requirement: Public agent endpoints are rate limited
The server SHALL count requests per client address and answer 429 `{ error: "rate_limited" }` with `Retry-After` once a limit is exceeded: `/oauth/register` 10 per hour, `/oauth/token` and `/oauth/revoke` 60 per minute, unauthenticated `/mcp` requests 30 per minute. The address SHALL be the last `X-Forwarded-For` entry when the TCP peer is loopback, and the peer's address otherwise. Authenticated `/mcp` requests SHALL be limited to 120 per minute per token.

#### Scenario: Registration flood
- **WHEN** one address sends an eleventh registration within an hour
- **THEN** the response is 429 with `Retry-After` and no client is stored

#### Scenario: Busy agent
- **WHEN** one token sends a 121st `/mcp` request within a minute
- **THEN** the response is 429 and no tool runs

#### Scenario: Forged header from a direct caller
- **WHEN** a non-loopback peer sends `X-Forwarded-For: 10.0.0.1`
- **THEN** it is counted under its own address
