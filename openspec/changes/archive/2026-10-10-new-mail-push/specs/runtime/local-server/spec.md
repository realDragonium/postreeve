## ADDED Requirements

### Requirement: Event stream endpoint
`GET /api/events` SHALL answer `text/event-stream` and stay open until the client disconnects. It SHALL be protected by the same optional bearer token as other API routes and SHALL send a keep-alive often enough that idle-connection timeouts do not close it.

#### Scenario: Token required
- **WHEN** the server runs with a desktop token and `/api/events` is requested without it
- **THEN** the response is 401

#### Scenario: Idle stream
- **WHEN** no mailbox changes occur for a minute
- **THEN** the stream stays open and the client receives keep-alives
