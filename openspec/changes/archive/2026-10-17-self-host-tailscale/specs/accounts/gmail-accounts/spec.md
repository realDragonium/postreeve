## MODIFIED Requirements

### Requirement: Authorization starts at Google with offline Gmail access
The system SHALL answer `GET /api/oauth/google/start` with a redirect to `https://accounts.google.com/o/oauth2/v2/auth` requesting `response_type=code`, the single scope `https://www.googleapis.com/auth/gmail.modify`, `access_type=offline`, `prompt=consent`, a fresh random `state`, and a PKCE `code_challenge` with `code_challenge_method=S256`. When `POSTREEVE_PUBLIC_URL` is set and `POSTREEVE_GOOGLE_REDIRECT` is not `loopback`, the `redirect_uri` SHALL be `<POSTREEVE_PUBLIC_URL origin>/api/oauth/google/callback`, for a Google "Web application" client. Otherwise it SHALL be `http://127.0.0.1:<PORT>/api/oauth/google/callback`, using the server's configured port. The token exchange SHALL send the same `redirect_uri`.

#### Scenario: Continue with Google
- **WHEN** a user selects **Continue with Google** on a server listening on port 3000 without a public URL
- **THEN** the browser is redirected to Google with scope `gmail.modify`, `code_challenge_method=S256` and `redirect_uri` `http://127.0.0.1:3000/api/oauth/google/callback`

#### Scenario: Hosted server
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://mail-box.example-tailnet.ts.net`
- **THEN** the `redirect_uri` is `https://mail-box.example-tailnet.ts.net/api/oauth/google/callback`

#### Scenario: Loopback fallback on a hosted server
- **WHEN** `POSTREEVE_PUBLIC_URL` is set and `POSTREEVE_GOOGLE_REDIRECT` is `loopback`
- **THEN** the `redirect_uri` is the loopback callback on the configured port

## ADDED Requirements

### Requirement: Invalid Google redirect configuration stops startup
When Google connection is configured, the server SHALL refuse to start if `POSTREEVE_GOOGLE_REDIRECT` is set to anything other than `public` or `loopback`, if it is `public` without `POSTREEVE_PUBLIC_URL`, or if `POSTREEVE_PUBLIC_URL` is not an `https://` origin (plain `http://` only for `127.0.0.1`, `localhost` or `[::1]`) or has a path, query, fragment or credentials.

#### Scenario: Public URL with a path
- **WHEN** `POSTREEVE_PUBLIC_URL` is `https://mail.example.test/postreeve` and Google is configured
- **THEN** the server exits during startup without listening

#### Scenario: Plain HTTP public URL
- **WHEN** `POSTREEVE_PUBLIC_URL` is `http://mail.example.test` and Google is configured
- **THEN** the server exits during startup without listening
