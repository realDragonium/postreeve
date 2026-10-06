# Gmail Accounts Specification

## Purpose
Covers connecting and reauthorizing Gmail accounts through Google OAuth: when the flow is available, how it starts, how the loopback callback stores the account and how the result returns to the web interface or desktop app. Listing and removing accounts are specified in accounts/imap-smtp-accounts; encryption of the stored refresh token in accounts/credential-vault; the desktop return address in runtime/desktop-app.

## Requirements

### Requirement: Google connection is available only when configured
The system SHALL consider Google connection configured only when both `POSTREEVE_GOOGLE_CLIENT_ID` and `POSTREEVE_GOOGLE_CLIENT_SECRET` are non-empty after trimming, and SHALL report this at `GET /api/oauth/google/status` as `{ configured }`. The web interface SHALL offer **Continue with Google** only when it is configured and otherwise show a hint to set the Google OAuth environment variables.

#### Scenario: Only the client ID is set
- **WHEN** the server starts with a Google client ID and no client secret
- **THEN** `GET /api/oauth/google/status` returns `{ configured: false }` and Settings shows the configuration hint

### Requirement: OAuth routes refuse to run without configuration
When Google connection is not configured, `GET /api/oauth/google/start` and `GET /api/oauth/google/callback` SHALL answer 400 `{ error: "Google account connection is not configured on this Postreeve server" }`.

#### Scenario: Starting without configuration
- **WHEN** `GET /api/oauth/google/start` is requested on an unconfigured server
- **THEN** the response is 400 with the not-configured error

### Requirement: Authorization starts at Google with offline Gmail access
The system SHALL answer `GET /api/oauth/google/start` with a redirect to `https://accounts.google.com/o/oauth2/v2/auth` requesting `response_type=code`, the single scope `https://www.googleapis.com/auth/gmail.modify`, `access_type=offline`, `prompt=consent`, a fresh random `state`, and a PKCE `code_challenge` with `code_challenge_method=S256`. The `redirect_uri` SHALL be `http://127.0.0.1:<PORT>/api/oauth/google/callback`, using the server's configured port.

#### Scenario: Continue with Google
- **WHEN** a user selects **Continue with Google** on a server listening on port 3000
- **THEN** the browser is redirected to Google with scope `gmail.modify`, `code_challenge_method=S256` and `redirect_uri` `http://127.0.0.1:3000/api/oauth/google/callback`

### Requirement: Authorization sessions are single-use and short-lived
The system SHALL hold each started authorization in server memory, accept its `state` at most once, and discard it 10 minutes after it was started. A callback with an unknown, already used or expired `state` SHALL fail. Sessions SHALL NOT survive a server restart.

#### Scenario: Replayed callback
- **WHEN** the same callback URL is requested a second time
- **THEN** the second request fails as a missing or expired session and stores nothing

#### Scenario: Slow consent
- **WHEN** Google redirects back more than 10 minutes after the flow started
- **THEN** the connection fails and the user must start again

### Requirement: The callback stores the account only after Gmail access works
On `GET /api/oauth/google/callback` the system SHALL exchange the code with the PKCE verifier and client secret, require a refresh token in Google's response, read the account's address from the Gmail profile, and verify Gmail access with that token before storing anything. It SHALL then store the refresh token encrypted and redirect to `/?google=connected&accountId=<id>`. The user's Google password MUST NOT pass through Postreeve.

#### Scenario: First connection
- **WHEN** a user grants consent for `person@example.test`
- **THEN** a Gmail account named `Gmail` with email `person@example.test` is stored and the browser returns to `/?google=connected&accountId=<id>`

#### Scenario: Google returns no refresh token
- **WHEN** the token response contains an access token but no refresh token
- **THEN** no account is stored and the browser returns with `google=error`

### Requirement: Reauthorization updates the matching Gmail account
When the authorized address matches an existing Gmail account's email case-insensitively, the system SHALL replace that account's refresh token and stored email, keeping its ID and name, instead of adding an account. An authorized address that matches no Gmail account SHALL create a new account. **Reauthorise** in Settings and **Reauthorize Google account** in the account sheet SHALL start the same flow as connecting.

#### Scenario: Reauthorizing after the token expired
- **WHEN** a user reauthorizes the Google account already connected as `Person@Example.test`
- **THEN** the existing account keeps its ID and name and uses the new refresh token

#### Scenario: Consenting with a different Google account
- **WHEN** a user selects **Reauthorise** and then consents as a Google account that is not yet connected
- **THEN** a second Gmail account is added and the first one is unchanged

### Requirement: Failed connections return a generic error result
When consent is denied or cancelled, the session is invalid, no code is returned, the token exchange fails, the profile cannot be read, Gmail access cannot be verified or the credentials cannot be stored, the system SHALL store nothing and redirect to `/?google=error`. The failure reason SHALL be logged on the server as a single line of at most 300 characters and MUST NOT appear in the redirect.

#### Scenario: User denies consent
- **WHEN** Google redirects back with an `error` parameter
- **THEN** the browser is redirected to `/?google=error` and no account changes

### Requirement: The web interface reports the result once
When the web interface loads with a `google` query parameter, it SHALL show "Google account connected." for `connected` and "Google account connection did not complete. Try again." otherwise, then remove `google` and `accountId` from the address without reloading.

#### Scenario: Returning after a successful connection
- **WHEN** the page opens at `/?google=connected&accountId=<id>`
- **THEN** the success notice is shown and the address bar no longer contains the query parameters
