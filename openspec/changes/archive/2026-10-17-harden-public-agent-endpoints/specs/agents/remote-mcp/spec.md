# Spec Delta

## ADDED Requirements

### Requirement: Public agent endpoints are rate limited
The server SHALL count requests per client address (the last `X-Forwarded-For` entry, added by the trusted proxy) and answer 429 `{ error: "rate_limited" }` with `Retry-After` once a limit is exceeded: `/oauth/register` 10 per hour, `/oauth/token` and `/oauth/revoke` 60 per minute, unauthenticated `/mcp` requests 30 per minute. Authenticated `/mcp` requests SHALL be limited to 120 per minute per token.

#### Scenario: Registration flood
- **WHEN** one address sends an eleventh registration within an hour
- **THEN** the response is 429 with `Retry-After` and no client is stored

#### Scenario: Busy agent
- **WHEN** one token sends a 121st `/mcp` request within a minute
- **THEN** the response is 429 and no tool runs

### Requirement: Public agent endpoints bound request bodies
The server SHALL refuse with 413 `{ error: "payload_too_large" }` a request body over 1 MiB on `/mcp` and over 16 KiB on `/oauth/register`, `/oauth/token` and `/oauth/revoke`, before parsing it.

#### Scenario: Oversized MCP request
- **WHEN** a client posts a 2 MiB body to `/mcp`
- **THEN** the response is 413 and no tool runs

### Requirement: Public agent endpoints hide internal failures
An unexpected failure while handling `/mcp`, the OAuth endpoints or the metadata endpoints SHALL be answered with 500 `{ error: "server_error" }` and no stack trace or internal message; the server SHALL log the failure.

#### Scenario: Internal error
- **WHEN** the database fails while a token is checked
- **THEN** the client receives 500 `server_error` without the database message
