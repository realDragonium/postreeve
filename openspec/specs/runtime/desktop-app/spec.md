# Desktop App Specification

## Purpose
Covers the Electron desktop shell: starting the compiled server as a sidecar on a temporary loopback port, serving the interface through the private `postreeve://` protocol with a per-launch API token, where configuration, data and the credential key come from in development and packaged builds, and the window's lifecycle. The server's own behavior, including how it enforces the token, is specified in runtime/local-server; credential encryption in accounts/credential-vault.

## Requirements

### Requirement: The server runs as a sidecar on a temporary loopback port
On launch the desktop app SHALL pick a free port on `127.0.0.1`, start the compiled Postreeve server with `POSTREEVE_HOST=127.0.0.1` and that `PORT`, and wait until `GET /api/health` succeeds. If the server exits or is not ready within 20 seconds, the app SHALL show the error dialog "Postreeve could not start", stop the server and quit. The app SHALL stop the server when it quits.

#### Scenario: Normal launch
- **WHEN** a user opens the desktop app
- **THEN** a server process listens on a loopback port chosen for this launch and the window opens after its health check succeeds

#### Scenario: Server fails during startup
- **WHEN** the server exits before its health check succeeds
- **THEN** the app shows "Postreeve could not start" with the exit code and quits

### Requirement: A fresh API token protects each launch
The desktop app SHALL generate a new random 32-byte token for every launch, pass it to the server as `POSTREEVE_DESKTOP_TOKEN`, and attach it as `Authorization: Bearer <token>` only to API requests it forwards. The token MUST NOT be exposed to the renderer, so other local processes cannot call the sidecar's API without it.

#### Scenario: Another local process calls the sidecar
- **WHEN** a process on the same machine requests `/api/accounts` on the sidecar's port without the token
- **THEN** the response is 401

#### Scenario: Relaunch
- **WHEN** the app quits and is opened again
- **THEN** the previous token no longer grants access and a new one is in use

### Requirement: The interface loads through the postreeve protocol
The desktop app SHALL load the interface from `postreeve://app/`. It SHALL forward paths under `/api/` to the sidecar with method, headers, body and query preserved and without following redirects, and serve every other path from the bundled web interface, falling back to `index.html` when no file matches. Bundle responses SHALL carry the server's Content-Security-Policy, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

#### Scenario: API call from the interface
- **WHEN** the interface fetches `postreeve://app/api/accounts`
- **THEN** the request reaches the sidecar with the launch token and the sidecar's response is returned

#### Scenario: Client-side route
- **WHEN** the window requests a path under `postreeve://app/` that matches no bundled file
- **THEN** the bundle's `index.html` is returned

### Requirement: The protocol serves only the bundle
The desktop app SHALL answer 404 for a `postreeve://` host other than `app` and for a path that is not valid URL encoding, contains a NUL byte or resolves outside the bundle. It SHALL answer 500 when the bundle has no `index.html`.

#### Scenario: Path traversal
- **WHEN** the renderer requests `postreeve://app/../../secrets`
- **THEN** the response is 404 and no file outside the bundle is read

### Requirement: Google authorization returns to the desktop app
The desktop app SHALL pass `POSTREEVE_DESKTOP_URL=postreeve://app/` to the sidecar so that a completed or failed Google authorization redirects to `postreeve://app/?google=<result>`, with `accountId` on success. Google's redirect URI SHALL be the sidecar's loopback callback on the port chosen for that launch.

#### Scenario: Connecting Gmail in the desktop app
- **WHEN** a user completes Google consent from the desktop app
- **THEN** the window returns to `postreeve://app/?google=connected&accountId=<id>` and shows the success notice

### Requirement: Configuration sources for development and packaged builds
In development the desktop app SHALL read only `POSTREEVE_DB_PATH`, `POSTREEVE_MASTER_KEY`, the Google client ID and secret, and the three byte-limit variables from the repository's `.env`, ignoring other keys and comments; the process environment SHALL override them. A packaged app SHALL NOT read a `.env` file. The desktop app SHALL always set the sidecar's host, port, token and return URL itself.

#### Scenario: Unrelated keys in .env
- **WHEN** the repository `.env` contains `PORT=4000` and `UNRELATED=value`
- **THEN** neither is passed from the file and the sidecar uses the port chosen for the launch

### Requirement: Database location
A packaged app SHALL store its database at `postreeve.sqlite` in the operating system's application-data directory for Postreeve unless `POSTREEVE_DB_PATH` is set in the environment. In development the app SHALL use `POSTREEVE_DB_PATH` from `.env` or the environment resolved relative to the repository, so `bun run desktop` shares the database of `bun run start`, and SHALL fall back to the application-data directory when it is not set.

#### Scenario: Development with the setup .env
- **WHEN** `bun run desktop` runs in a checkout prepared with `bun run setup:local`
- **THEN** the sidecar uses `<repository>/data/postreeve.sqlite`

#### Scenario: Packaged app on macOS
- **WHEN** the packaged app starts without `POSTREEVE_DB_PATH`
- **THEN** the database is `~/Library/Application Support/Postreeve/postreeve.sqlite`

### Requirement: The desktop app keeps its own credential key
When no `POSTREEVE_MASTER_KEY` is configured, the desktop app SHALL use the key in `master-key` in the application-data directory, generating a random 32-byte key on first launch and writing it once with file mode 0600. It SHALL encrypt that file with the operating system's secure storage when available and otherwise store the key unencrypted. A configured `POSTREEVE_MASTER_KEY` SHALL take precedence over the stored key.

#### Scenario: First packaged launch
- **WHEN** a packaged app starts for the first time on a system with secure storage
- **THEN** a new key is generated, stored encrypted by the operating system, and passed to the sidecar

#### Scenario: Later launches
- **WHEN** the app starts again
- **THEN** it reads the same key and the stored accounts remain usable

### Requirement: An unreadable desktop key stops startup
The desktop app SHALL fail to start with "Operating-system secure storage is unavailable" when its key was stored with secure storage and secure storage cannot be used, and SHALL fail to start when `master-key` has an unknown format. It MUST NOT replace an existing key file.

#### Scenario: Secure storage disappears
- **WHEN** the stored key was encrypted with secure storage and secure storage is unavailable at launch
- **THEN** the app shows "Postreeve could not start" with that message and does not start the server

### Requirement: One sandboxed window per installation
The desktop app SHALL run a single instance; launching it again SHALL restore and focus the existing window. The renderer SHALL run sandboxed with context isolation and without Node integration, and links that would open a new window SHALL open in the system browser instead. Closing the last window SHALL quit the app except on macOS, where activating the app reopens the window.

#### Scenario: Second launch
- **WHEN** a user opens Postreeve while it is already running
- **THEN** no second sidecar starts and the existing window comes to the front

#### Scenario: External link
- **WHEN** a link in the interface targets a new window
- **THEN** it opens in the system browser and no Electron window is created
