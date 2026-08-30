# Postreeve repository guidance

## Setup

- Install Bun 1.4 or newer.
- Run `bun install`.
- Run `bun run setup:local` to create the ignored `.env` and data directory without printing the generated encryption key.
- Run `bun run verify` before starting the app.
- Run `bun run start`, then open `http://127.0.0.1:3000`.

## Verification

- Use `bun run typecheck` for strict TypeScript checks.
- Use `bun run test` for deterministic unit and contract tests.
- Use `bun run build` for the production web bundle.
- Use `bun run test:e2e` only when a browser is available.

## Safety

- Keep Postreeve bound to loopback unless the user explicitly requests and secures another deployment model. The web interface does not have authentication yet.
- Use deterministic test doubles for automated verification. Do not connect a mailbox, enter credentials, send mail, or modify live mail unless the user explicitly requests that action. When the user does request live testing, recommend starting with a secondary mailbox.
- Never print, commit, or expose `.env`, `POSTREEVE_MASTER_KEY`, mailbox passwords, or the SQLite data files.
- Preserve the human approval boundary. An agent may prepare or update a proposal, but only the human-facing UI may approve it.
