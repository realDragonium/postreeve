# Postreeve

Postreeve is a self-hosted email client for humans and agents. It connects to standard IMAP and SMTP accounts while keeping credentials and control on your machine.

Humans can read, search, compose, send, mark, move, and safely trash mail across multiple accounts. Agents inspect mail through WebMCP and prepare structured triage proposals. Humans review every action and explicitly approve it before Postreeve changes any mail. Applied work remains visible and supported actions can be undone.

## Local setup

Requirements:

- [Bun](https://bun.sh/) 1.4 or newer
- Git
- The latest ChatGPT desktop app for WebMCP site tools

Install and verify Postreeve:

```bash
bun install
bun run setup:local
bun run verify
bun run start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). A new installation starts empty and asks you to connect an email account.

`bun run setup:local` creates an ignored `.env`, generates a 32-byte encryption key without printing it, and prepares the local data directory. Keep that `.env` backed up securely. Existing encrypted account credentials cannot be recovered if `POSTREEVE_MASTER_KEY` is lost or changed.

Postreeve binds to `127.0.0.1` by default because the web interface does not have authentication yet. Do not expose it to a public or shared network.

## Connect an email account

Select **Add account** and enter the IMAP and SMTP settings supplied by your email provider. Postreeve authenticates to both services before saving the encrypted credentials. The SMTP check uses the provider's non-sending verification mechanism. Prefer an app-specific password when the provider supports one. OAuth is not implemented yet.

Use **Manage** next to the selected account to test its connection, change settings, reconnect with new passwords, or remove the account and its local workflow history. Stored passwords are never returned to the browser; blank password fields preserve the current values.

Start with a secondary mailbox and verify these actions manually before relying on the agent workflow:

1. Read and search messages.
2. Send a message to yourself.
3. Mark a message read and unread.
4. Move a message between folders.
5. Move a message to Trash.

Passwords are encrypted with AES-256-GCM before they are stored in the local SQLite database. They are never sent to OpenAI by Postreeve.

## Use WebMCP with Codex

Keep Postreeve open in the built-in browser in the ChatGPT desktop app. Select **Site tools** in the address bar, then **Available site tools**, to inspect the tools exposed by the page.

Start with a read-and-propose request:

> List my accounts and folders. Inspect unread messages in my inbox and create a triage proposal. Do not apply anything.

Review the proposal in Postreeve and approve it yourself. Codex can then apply the approved proposal and undo supported operations. WebMCP cannot approve proposals or send email; those remain human-only UI actions.

Use GPT-5.6 Sol or GPT-5.6 Terra for site tools. GPT-5.6 Luna currently has WebMCP disabled.

## Docker

Create the local `.env` first, then start the container:

```bash
bun run setup:local
docker compose up --build
```

Docker Compose publishes Postreeve only on `127.0.0.1:3000` and stores SQLite data in the `postreeve-data` volume.

## Commands

- `bun run setup:local`: create local private configuration without overwriting an existing `.env`
- `bun run verify`: run strict typechecking, deterministic tests, and the production build
- `bun run start`: serve the production application
- `bun run dev`: run the API server in watch mode after building the web application
- `bun run test:e2e`: run the Playwright browser workflow

Licensed under the [Apache License 2.0](LICENSE).
