# Postreeve

Postreeve is a self-hosted email client for humans and agents. It connects to Gmail through Google OAuth and to standard providers through IMAP and SMTP while keeping credentials and control on your machine.

Humans can read, search, compose, send, mark, move, and safely trash mail across multiple accounts. External agents can inspect mail and apply explicit mailbox actions through page-scoped WebMCP tools. Applied work remains visible in Activity and supported actions can be undone.

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

## Desktop app

Run Postreeve as a desktop application without starting the server manually:

```bash
bun run desktop
```

The development desktop app reuses the repository's private `.env` and database. It starts a compiled Bun sidecar on a temporary loopback port and stops it when the application quits.

Create an unpacked application bundle with `bun run desktop:pack`, or platform installers with `bun run desktop:dist`. Packaged applications keep their database in the operating system's application-data directory and protect the generated credential key with Electron's secure storage when it is available.

## Connect an email account

For Gmail, create a Google OAuth desktop client with the Gmail API enabled and the `gmail.modify` scope, then add its public client ID to the ignored `.env`:

```bash
POSTREEVE_GOOGLE_CLIENT_ID=your-desktop-client-id
POSTREEVE_GOOGLE_CLIENT_SECRET=your-desktop-client-secret
```

Restart Postreeve, select **Add account**, and choose **Continue with Google**. Google redirects back to the loopback-only Postreeve server. Postreeve stores the refresh token in the encrypted credential vault; your Google password never enters the app. Google OAuth apps in Testing mode issue refresh tokens that expire after seven days, so local testing may require periodic reauthorization.

For other providers, select **Add account** and enter the IMAP and SMTP settings supplied by your email provider. Postreeve authenticates to both services before saving the encrypted credentials. The SMTP check uses the provider's non-sending verification mechanism. Prefer an app-specific password when the provider supports one.

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

Start with a scoped request:

> List my accounts and folders. Inspect unread messages in my inbox, explain what you recommend, and wait for my next instruction before applying actions.

WebMCP mirrors the completed mailbox workflow available in the UI: it can inspect accounts, folders, and messages; send a new message from an account's primary address; apply explicit move, Trash, and read-state actions; inspect Activity; and undo supported operations. Sending real mail requires explicit user approval. Permanent deletion remains unavailable everywhere.

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
- `bun run desktop`: build and open the Electron desktop application
- `bun run desktop:pack`: create an unpacked desktop application
- `bun run desktop:dist`: create the current platform's desktop installers
- `bun run test:e2e`: run the Playwright browser workflow

Licensed under the [Apache License 2.0](LICENSE).
