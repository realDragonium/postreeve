# Postreeve

Postreeve is a self-hosted email client for humans and agents. It connects to Gmail through Google OAuth and to standard providers through IMAP and SMTP while keeping credentials and control on your machine.

Humans can read, search, compose, send, mark, move, and safely trash mail across multiple accounts. External agents can inspect mail and apply explicit mailbox actions through page-scoped WebMCP tools. Applied work remains visible in Activity and supported actions can be undone.

Gmail synchronization consumes account history and repairs expired cursors through bounded full-message pages followed by history catch-up. Repair preserves existing canonical messages, conversations and local workflow references; incomplete repairs retain unseen locations until the account snapshot finishes.

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

The development desktop app reuses the repository's private `.env` and database. It starts a compiled Bun sidecar on a temporary loopback port and stops it when the application quits. Electron loads the web bundle through the private `postreeve://` protocol and proxies API calls with a fresh authentication token that exists only for that launch.

Create an unpacked application bundle with `bun run desktop:pack`, or platform installers with `bun run desktop:dist`. Packaged applications keep their database in the operating system's application-data directory and protect the generated credential key with Electron's secure storage when it is available.

## Connect an email account

For Gmail, create a Google OAuth desktop client with the Gmail API enabled and the `gmail.modify` scope, then add its public client ID to the ignored `.env`:

```bash
POSTREEVE_GOOGLE_CLIENT_ID=your-desktop-client-id
POSTREEVE_GOOGLE_CLIENT_SECRET=your-desktop-client-secret
```

Restart Postreeve, select **Add account**, and choose **Continue with Google**. Google redirects back to the loopback-only Postreeve server. Postreeve stores the refresh token in the encrypted credential vault; your Google password never enters the app. Google OAuth apps in Testing mode issue refresh tokens that expire after seven days, so local testing may require periodic reauthorization.

For other providers, select **Add account**, enter the email address and select **Find settings**. Postreeve proposes IMAP and SMTP settings from its built-in list (iCloud including me.com and mac.com, Fastmail, Yahoo, AOL, Zoho, GMX, Gmail), the domain's own Thunderbird autoconfig file, the Thunderbird ISPDB at `autoconfig.thunderbird.net`, or the domain's MX host when it belongs to one of those providers (for example a custom domain hosted at iCloud or Fastmail). Lookups run on the server over HTTPS only, never follow redirects, time out after five seconds, read at most 64 KiB and never include your password or email address. Every proposed field stays editable, and providers that need an app-specific password show how to create one. Gmail addresses point to **Continue with Google** when it is configured. Outlook.com/Hotmail and Proton Mail are recognized but cannot be connected yet: Microsoft requires its own sign-in, and Proton Mail Bridge uses a self-signed certificate. You can also enter the settings supplied by your provider by hand. Postreeve authenticates to both services before saving the encrypted credentials. The SMTP check uses the provider's non-sending verification mechanism. Prefer an app-specific password when the provider supports one.

Many IMAP providers, such as iCloud, do not keep mail submitted over SMTP, so Postreeve appends a copy of each sent message to the account's Sent folder. Gmail and Outlook/Office 365 file sent mail themselves; for those hosts **Save a copy to Sent** starts off to avoid duplicates. Change it under **Manage** for the account. If saving the copy fails, the message is still sent and the send result shows a warning.

Use **Manage** next to the selected account to test its connection, change settings, reconnect with new passwords, or remove the account and its local workflow history. Stored passwords are never returned to the browser; blank password fields preserve the current values.

Start with a secondary mailbox and verify these actions manually before relying on the agent workflow:

1. Read and search messages.
2. Send a message to yourself.
3. Mark a message read and unread.
4. Move a message between folders.
5. Move a message to Trash.

Passwords are encrypted with AES-256-GCM before they are stored in the local SQLite database. They are never sent to OpenAI by Postreeve.

The backend maintains a local summary index through durable account synchronization jobs, even with no mailbox view open. Jobs retain checkpoints across restart, back off after failures, and reject results from canceled or disconnected accounts. The compatibility ingestion path records partial coverage and preserves unseen locations; offline mailbox views are a separate capability.

IMAP synchronization resumes bounded mailbox scans after reconnect, uses negotiated QRESYNC and MODSEQ when available, and falls back to full summary observations otherwise. Incomplete fetches keep the prior checkpoint and cached locations. UIDVALIDITY resets rebuild only the affected mailbox while preserving canonical messages and conversation identity. Large summary batches are split into bounded pages. An individual summary that exceeds the 2 MiB ingestion limit is reported as invalid data and keeps its checkpoint unchanged.

New mail arrives without waiting for the poll. Each IMAP account keeps one extra connection idling on INBOX (when the server supports IDLE) and synchronizes the Inbox as soon as the server reports a change. It re-IDLEs every 25 minutes and reconnects with backoff up to 15 minutes. Without IDLE, the 60-second poll still applies. Gmail account history is polled every 20 seconds. A new scan of an IMAP mailbox ingests messages above its last completed scan first. The server pushes mailbox-change and new-mail events to the open page over `GET /api/events` (Server-Sent Events), so lists and folder counts refresh straight away. **Settings → Notifications** enables desktop notifications for unread Inbox arrivals (off by default; the browser or operating system asks for permission) and mutes individual accounts. Notifications appear only while the window is in the background, are summarized when more than three arrive at once, and open the message when clicked. Initial synchronization and repairs never notify.

Synchronization health is available in **Settings → Sync & storage**, including safe retry and human reauthorization instructions. Health distinguishes healthy, catching up, degraded, disconnected and reauthorization required. Authentication failures pause automatic retries; failures contain fixed actionable guidance, never raw provider responses.

Retained preview and bounded searchable body text expire 30 days after refresh and are limited to 100 MiB per account by default. Set `POSTREEVE_CONTENT_RETENTION_DAYS` (1–3650) and `POSTREEVE_CONTENT_RETENTION_BYTES` (positive integer) to change these server-wide defaults. Retention clears the oldest eligible preview/body content, preserving every indexed message's headers, identity, locations, conversation links and proposal history. It does not bound total database size or change provider mail. Full bodies remain fetched on demand. Synchronization indexes up to 32,768 characters of body text from bounded MIME reads (64 KiB text/source budget); missing or expired content is reported separately from synchronization coverage. SQLite search matches literal case-insensitive text in sender, recipients, subject, retained headers, preview and body fields; Gmail query syntax is not supported. Account and unified mailbox views use backend cursor pages of 50, with no 100-message navigation ceiling. Provider fallback is bounded to 100 matches per source, 10 source calls, 1,000 search matches and five seconds of waiting per query; failures leave cached results usable. Cursor ordering uses the first indexed canonical date/sender/subject, so newly observed duplicate copies cannot move existing rows between pages. Displayed metadata and location flags remain current. Cursors are bound to sources, query, filter and sort; canonical identity merges and deletions do not promise a frozen snapshot.

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

### Draft file storage and outgoing limits

Files selected in compose upload into the saved draft. Postreeve stores their bytes in its SQLite database and exposes only opaque file IDs in draft metadata. Files survive another client, restart, and failed delivery. Retry failed uploads in the open compose form; failed or uncertain sends retain the stored files. An uncertain send still requires the existing explicit recovery-copy action before another delivery attempt.

`POSTREEVE_MAX_UPLOAD_BYTES` sets the maximum actual bytes per uploaded file (default 20 MiB). `POSTREEVE_MAX_MESSAGE_BYTES` sets the maximum complete encoded MIME message (default 25 MiB), including body, headers, attachment encoding, and multipart overhead. Both settings require positive integers. Gmail and SMTP enforce the message limit before dispatch; provider mirrors use the same limit. Base64 overhead means the permitted total file content is smaller than the encoded-message limit. These application limits do not override a provider's own limits. The received-download setting `POSTREEVE_MAX_ATTACHMENT_BYTES` is independent.

Uploads commit their bytes and versioned draft ownership together. Rejected uploads leave no staged blobs. Removing a file or deleting its draft deletes the corresponding owned bytes transactionally; recovery copies retain independent bytes. Settled drafts retain their files with their delivery receipt until the draft or account is removed. Old drafts migrated from browser storage show missing file content explicitly because those records never contained the bytes; remove or attach those files again before sending. Ordinary file attachments are supported; inline/CID rendering remains outside this feature.
