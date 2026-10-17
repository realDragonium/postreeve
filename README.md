# Postreeve

Postreeve is a self-hosted email client for humans and agents. It connects to Gmail through Google OAuth and to standard providers through IMAP and SMTP while keeping credentials and control on your machine.

Humans can read, search, compose, send, mark, move, and safely trash mail across multiple accounts. External agents can inspect mail, prepare proposals and apply explicit mailbox actions through page-scoped WebMCP tools or, once you authorize them, through the remote MCP endpoint at `/mcp`. Applied work remains visible in Activity and supported actions can be undone.

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

Open [http://localhost:3000](http://localhost:3000). A new installation first asks you to claim it as its owner (see [Sign-in](#sign-in)), then to connect an email account. Press `?` for keyboard shortcuts. Chromium-based browsers and Safari can install Postreeve as an app from this address; the installed app caches only the interface, never mail.

`bun run setup:local` creates an ignored `.env`, generates a 32-byte encryption key without printing it, and prepares the local data directory. Keep that `.env` backed up securely. Existing encrypted account credentials cannot be recovered if `POSTREEVE_MASTER_KEY` is lost or changed.

Postreeve binds to `127.0.0.1` by default. Serve it to other machines only over https with `POSTREEVE_PUBLIC_URL` set (see [Hosting](#hosting)).

To block pages that rebind their own domain to your machine, the server only answers requests addressed to `127.0.0.1`, `localhost` or `[::1]` (on any port), plus the address in `POSTREEVE_HOST` when it names one and the host of `POSTREEVE_PUBLIC_URL`, and it rejects API writes sent from another site. Binding to `0.0.0.0` therefore still accepts only those names.

### Sign-in

Postreeve has one owner, and every API call, including the live event stream and attachment downloads, needs the owner's session. Only `GET /api/health` and the sign-in endpoints are public.

On first start without an owner, the server logs `Postreeve has no owner yet. Setup token for this run: …`. Open Postreeve, enter that token and choose a password of at least 12 characters. Set `POSTREEVE_SETUP_TOKEN` (16 characters or more) instead to choose the token yourself; the server never logs a token from the environment. The token stops working once the owner exists, so a stranger who finds a fresh public instance cannot claim it.

Right after setup Postreeve offers to add a passkey. Passkeys are the primary sign-in and the password is the fallback. Passkeys need a domain name over a secure connection, so they work at `http://localhost:3000` and at the `POSTREEVE_PUBLIC_URL` address, not at `http://127.0.0.1:3000`. A passkey belongs to the address it was created on. **Settings → Security** adds and removes passkeys, changes the password (which signs out every other session), lists sessions, signs out one or all other sessions, and signs out.

Sessions end after 7 days without use and 30 days after sign-in at the latest. The session cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` over https. The database stores only a hash of each session token and an argon2id hash of the password. After 5 failed attempts in 15 minutes a client must wait; after 50 failed password or setup attempts from all clients, password sign-in pauses for everyone while passkeys keep working.

Lost both the password and every passkey? Stop Postreeve, run `sqlite3 data/postreeve.sqlite "DELETE FROM owner; DELETE FROM owner_sessions; DELETE FROM owner_passkeys;"`, and start it again to get a new setup token. Mail accounts and history are kept.

The desktop app does not use owner sign-in; its per-launch token authenticates it.

### Hosting

| Variable | Purpose |
| --- | --- |
| `POSTREEVE_PUBLIC_URL` | The https origin people open, for example `https://box.tail1234.ts.net` behind `tailscale serve`. Its host is accepted by the host check, it is the passkey origin and relying party, and session cookies are `Secure` there. |
| `POSTREEVE_TRUST_PROXY` | Set to `1` behind a reverse proxy such as `tailscale serve` so the server believes the rightmost `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` values. Leave it unset when clients reach Postreeve directly, or they could forge these headers. Tailscale identity headers such as `Tailscale-User-Login` are never treated as sign-in: anything that reaches the port can send them. |
| `POSTREEVE_SETUP_TOKEN` | Optional fixed setup token for claiming a new instance. |

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

Restart Postreeve, select **Add account**, and choose **Continue with Google**. Google redirects back to the loopback-only Postreeve server (a hosted server with `POSTREEVE_PUBLIC_URL` uses a Web application client instead; see [docs/self-host.md](docs/self-host.md#google-accounts)). Postreeve stores the refresh token in the encrypted credential vault; your Google password never enters the app. Google OAuth apps in Testing mode issue refresh tokens that expire after seven days, so local testing may require periodic reauthorization.

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

Retained preview and bounded searchable body text expire 365 days after refresh and are limited to 64 MiB per account by default. On disk the index costs about five times the retained text (the summary copy, the full-text copy and its trigram index), so the default budget bounds an account's searchable content at roughly 320 MiB; lower `POSTREEVE_CONTENT_RETENTION_BYTES` on a small volume with several busy accounts. Set `POSTREEVE_CONTENT_RETENTION_DAYS` (1–3650) and `POSTREEVE_CONTENT_RETENTION_BYTES` (positive integer) to change these server-wide defaults. Retention clears the oldest eligible preview/body content, preserving every indexed message's headers, identity, locations, conversation links and proposal history. It does not bound total database size or change provider mail. Full bodies remain fetched on demand. Synchronization indexes up to 32,768 characters of body text from bounded MIME reads (64 KiB text/source budget); missing or expired content is reported separately from synchronization coverage.

Search matches words and `"quoted phrases"` as literal case-insensitive text in sender, recipients, subject, retained headers, preview and body fields. Operators narrow it: `from:`, `to:` (any recipient), `cc:`, `subject:`, `has:attachment` (a `multipart/mixed` message), `is:unread`, `is:read`, `is:flagged`, `before:YYYY-MM-DD` and `after:YYYY-MM-DD` (UTC days, received time), `in:<folder>` (path, last path segment or a special-use name such as `in:sent`), `account:<address or name>`, and `in:anywhere`; a leading `-` negates any term or operator. Unknown `name:value` words stay literal text. The same query string works in the search box and in the WebMCP `search_messages` tool. **Everywhere** in the list header (or `in:anywhere`) searches every indexed folder of every account from the local index only, without provider fallback. Account and unified mailbox views use backend cursor pages of 50, with no 100-message navigation ceiling. Provider fallback searches the free text only, and is bounded to 100 matches per source, 10 source calls, 1,000 search matches and five seconds of waiting per query; failures leave cached results usable. Cursor ordering uses the first indexed canonical date/sender/subject, kept in an indexed sort-key table, so newly observed duplicate copies cannot move existing rows between pages. Displayed metadata and location flags remain current. Cursors are bound to sources, scope, query, filter, sort and grouping; canonical identity merges and deletions do not promise a frozen snapshot. **Conversations** in the list header groups the list into one row per conversation in the current view, showing participants, the message count, the latest snippet and unread state; an action on a group applies to each of its messages in the view.

`bun scripts/bench-mail-query.ts [count] [runs]` seeds synthetic summaries into a temporary SQLite file and prints p50/p95 page latency for list, unified, search and grouped queries.

## Use WebMCP with Codex

Keep Postreeve open in the built-in browser in the ChatGPT desktop app. Select **Site tools** in the address bar, then **Available site tools**, to inspect the tools exposed by the page.

Start with a scoped request:

> List my accounts and folders. Inspect unread messages in my inbox, explain what you recommend, and wait for my next instruction before applying actions.

WebMCP mirrors the completed mailbox workflow available in the UI: it can inspect accounts, folders, and messages; send a new message from an account's primary address; apply explicit move, Trash, and read-state actions; inspect Activity; and undo supported operations. Sending real mail requires explicit user approval. Permanent deletion is never available to agents; people can delete from an IMAP account's Trash or Spam after a confirmation dialog.

Use GPT-5.6 Sol or GPT-5.6 Terra for site tools. GPT-5.6 Luna currently has WebMCP disabled.

## Connect remote agents over MCP

Postreeve serves MCP at `<your origin>/mcp` with OAuth 2.1 (PKCE and dynamic client registration). Set `POSTREEVE_PUBLIC_URL` to the hosted origin, such as `https://mail.example.com`, so the advertised OAuth URLs match; on loopback the request origin is used. Each connection opens a consent page in your signed-in browser where you choose **Read only**, **Read and prepare** (recommended: the agent proposes mailbox changes and drafts replies, you accept and send) or **Read, prepare and act**, and which accounts it may reach. Remote agents can never send mail, send a draft, or accept or decline a proposal. Manage and revoke connections under **Settings → Connected agents**; every call they make shows in Activity under their name.

- **claude.ai**: Settings → Connectors → Add custom connector, URL `https://mail.example.com/mcp`. Leave the OAuth client fields empty; Claude registers itself.
- **Claude Code**: `claude mcp add --transport http postreeve https://mail.example.com/mcp`, then run `/mcp` in Claude Code to sign in. For a headless machine, create a personal access token in Settings and add `--header "Authorization: Bearer <token>"` instead.
- **ChatGPT**: Settings → Connectors → Advanced → enable Developer mode, then Create connector with the URL `https://mail.example.com/mcp` and OAuth authentication.

If agents reach Postreeve on a different origin than your browser (for example `https://mcp.example.com` published by a reverse proxy while the UI stays on your tailnet), set `POSTREEVE_MCP_PUBLIC_URL` to that origin: it becomes the OAuth issuer and the `/mcp` resource, while the consent page stays on `POSTREEVE_PUBLIC_URL`, and connectors use `<POSTREEVE_MCP_PUBLIC_URL>/mcp`.

When only the agent endpoints face the internet, serve them from a separate listener built with `createPublicAgentAccess`, which carries exactly these paths and answers 404 to everything else, or expose exactly `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/revoke`. Keep `/oauth/authorize` private: your own browser opens it, so it only needs to be reachable from your devices. These endpoints are rate limited (per client address, taken from `X-Forwarded-For` only when the connection comes from a loopback proxy, and per token on `/mcp`), cap request bodies at 1 MiB (`/mcp`) and 16 KiB (OAuth), and answer unexpected failures with a bare `server_error`.

## Docker

Create the local `.env` first, then start the container:

```bash
bun run setup:local
docker compose up --build
```

Docker Compose publishes Postreeve only on `127.0.0.1:3000`, stores SQLite data in the `postreeve-data` volume and writes daily snapshots to `./backups`. Find the setup token for a new instance with `docker compose logs postreeve`.

## Self-hosting

To run Postreeve on an always-on machine and use it from your other devices, follow [docs/self-host.md](docs/self-host.md): Docker Compose on loopback, the UI over HTTPS on your tailnet through `tailscale serve`, Caddy as the public TLS front for mail and the remote MCP endpoints, a firewall, Google OAuth on the hosted URL, scheduled `VACUUM INTO` snapshots with restore, and graceful shutdown.

## Commands

- `bun run setup:local`: create local private configuration without overwriting an existing `.env`
- `bun run verify`: run strict typechecking, deterministic tests, and the production build
- `bun run start`: serve the production application
- `bun run backup [create | list | verify <file> | restore <file>]`: snapshot or restore the database (see the self-hosting guide)
- `bun run dev`: run the API server in watch mode after building the web application
- `bun run desktop`: build and open the Electron desktop application
- `bun run desktop:pack`: create an unpacked desktop application
- `bun run desktop:dist`: create the current platform's desktop installers
- `bun run test:e2e`: run the Playwright browser workflow (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an already installed Chromium)

Licensed under the [Apache License 2.0](LICENSE).

### Draft file storage and outgoing limits

Files selected in compose upload into the saved draft. Postreeve stores their bytes in its SQLite database and exposes only opaque file IDs in draft metadata. Files survive another client, restart, and failed delivery. Retry failed uploads in the open compose form; failed or uncertain sends retain the stored files. An uncertain send still requires the existing explicit recovery-copy action before another delivery attempt.

`POSTREEVE_MAX_UPLOAD_BYTES` sets the maximum actual bytes per uploaded file (default 20 MiB). `POSTREEVE_MAX_MESSAGE_BYTES` sets the maximum complete encoded MIME message (default 25 MiB), including body, headers, attachment encoding, and multipart overhead. Both settings require positive integers. Gmail and SMTP enforce the message limit before dispatch; provider mirrors use the same limit. Base64 overhead means the permitted total file content is smaller than the encoded-message limit. These application limits do not override a provider's own limits. The received-download setting `POSTREEVE_MAX_ATTACHMENT_BYTES` is independent.

Uploads commit their bytes and versioned draft ownership together. Rejected uploads leave no staged blobs. Removing a file or deleting its draft deletes the corresponding owned bytes transactionally; recovery copies retain independent bytes. Settled drafts retain their files with their delivery receipt until the draft or account is removed. Old drafts migrated from browser storage show missing file content explicitly because those records never contained the bytes; remove or attach those files again before sending. Ordinary file attachments are supported; inline/CID rendering remains outside this feature.
