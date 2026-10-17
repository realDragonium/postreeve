# Postreeve repository guidance

## Changes go through OpenSpec

Every requested change uses the OpenSpec workflow; `openspec/specs/` describes current behavior.

1. Propose with `/opsx:propose` (Codex: `$openspec-propose`), or `/opsx:explore` first when the direction is unclear. This writes `openspec/changes/<name>/` with the proposal, delta specs, design and tasks. Continue to implementation without waiting for the user's review.
2. Implement with `/opsx:apply`, checking off `tasks.md` as you go.
3. Archive with `/opsx:archive` once the change is implemented and verified, in the same pull request, so the main specs merge together with the code.

A change with no behavior change (refactor, tooling, docs only) sets `skip_specs: true` in its `.openspec.yaml` instead of inventing requirements. If `openspec` is not on `PATH`, run it as `bunx openspec`. Check specs with `bunx openspec validate --specs --strict`.

## Decision authority

The agent working on a change has full authority to make product and technical decisions as it sees fit: scope, design, dependencies, and whether to propose, implement and archive in one go. Record the reasoning in the change's `design.md` instead of asking. Stop and ask the user only before a destructive action: deleting or rewriting history, force-pushing, dropping data or migrations that lose data, deleting branches, repositories or deployments, or touching live mail and credentials beyond what the Safety section allows.

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

- Keep Postreeve bound to loopback unless the user explicitly requests and secures another deployment model. A public deployment needs https and `POSTREEVE_PUBLIC_URL`; the owner signs in with a passkey or password (runtime/owner-auth).
- Never print or commit a real `POSTREEVE_SETUP_TOKEN` or a generated setup token from a server log.
- Use deterministic test doubles for automated verification. Do not connect a mailbox, enter credentials, send mail, or modify live mail unless the user explicitly requests that action. When the user does request live testing, recommend starting with a secondary mailbox.
- Never print, commit, or expose `.env`, `POSTREEVE_MASTER_KEY`, mailbox passwords, or the SQLite data files.
- Preserve the human approval boundary. An agent may prepare or update a proposal, but only the human-facing UI may approve it.
