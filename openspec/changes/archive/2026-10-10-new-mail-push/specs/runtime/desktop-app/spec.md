## MODIFIED Requirements

### Requirement: The interface loads through the postreeve protocol
The desktop app SHALL load the interface from `postreeve://app/`. It SHALL forward paths under `/api/` to the sidecar with method, headers, body and query preserved and without following redirects, streaming response bodies as they arrive, and serve every other path from the bundled web interface, falling back to `index.html` when no file matches. Bundle responses SHALL carry the server's Content-Security-Policy, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

#### Scenario: API call from the interface
- **WHEN** the interface fetches `postreeve://app/api/accounts`
- **THEN** the request reaches the sidecar with the launch token and the sidecar's response is returned

#### Scenario: Event stream through the protocol
- **WHEN** the interface opens `postreeve://app/api/events`
- **THEN** events reach the interface as the sidecar sends them, without waiting for the stream to end

#### Scenario: Client-side route
- **WHEN** the window requests a path under `postreeve://app/` that matches no bundled file
- **THEN** the bundle's `index.html` is returned
