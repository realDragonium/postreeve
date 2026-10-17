# Postreeve feature and WebMCP coverage

This document tracks what a person can currently do in Postreeve's web interface and whether the same capability is available to agents: through page-scoped WebMCP, and through the authorized remote MCP endpoint at `/mcp`, which shares the same tool definitions (see [Remote MCP](#remote-mcp)).

WebMCP follows one product rule: it mirrors user mailbox workflows and must not introduce a separate agent-only workflow. A missing WebMCP capability in this document describes the current implementation, not a decision that the gap should remain.

## Status legend

| Status | Meaning |
| --- | --- |
| Complete | Works end to end against the configured mail provider. |
| Partial | The UI exists, but some state is local-only or provider behavior is unavailable. |
| Not available | The capability is not implemented. |
| Not covered | The capability works in the UI, but no matching WebMCP tool exists today. |
| Equivalent | WebMCP can achieve the same result without a dedicated tool. |

## Accounts

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| List configured accounts | Complete | Complete | `list_accounts` |
| Switch the active account | Complete | Equivalent | Tools accept an explicit `accountId`; no global active-account state is needed. |
| Use multiple Gmail and IMAP/SMTP accounts | Complete | Complete | All mailbox tools are scoped by `accountId`. |
| Connect Gmail through Google OAuth | Complete | Not covered | No matching WebMCP tool exists. The current UI uses an interactive Google login and consent flow. |
| Add an IMAP/SMTP account | Complete | Not covered | No matching WebMCP tool exists. |
| Propose IMAP/SMTP settings from an email address | Complete | Not covered | **Find settings** uses the built-in provider list (including Strato custom domains by MX and Proton Mail Bridge's local defaults), Thunderbird autoconfig, the ISPDB and MX matching, with fixed app-password guidance. No matching WebMCP tool exists. |
| Test IMAP and SMTP settings | Complete | Not covered | No matching WebMCP tool exists. |
| Trust a self-signed or IP-addressed server certificate | Complete | Not covered | A failed test shows the IMAP or SMTP certificate's SHA-256 fingerprint, subject and validity; the owner can pin it per account. Pinned connections verify the exact certificate, and a changed one pauses synchronization for review. Covers self-hosted servers such as poste.io and Proton Mail Bridge. |
| Update or reconnect an IMAP/SMTP account | Complete | Not covered | No matching WebMCP tool exists. |
| Reauthorize Gmail | Complete | Partial | `request_reauthorization` provides human guidance; Google login and consent remain interactive UI steps. |
| Remove an account and its local history | Complete | Not covered | No matching WebMCP tool exists. Removing an account through the UI never deletes provider mail. |

## Owner sign-in

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Claim a new instance with the setup token | Complete | Not covered | Owner setup happens before any page tools register. |
| Sign in with a passkey or the password | Complete | Not covered | WebMCP tools run inside the signed-in page and use its session; they never sign in. |
| Manage passkeys, the password and sessions | Complete | Not covered | **Settings → Security** is a human-only workflow; no tool may change the owner's credentials. |

## Folders and mailbox navigation

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| List folders | Complete | Complete | `list_folders` |
| Show total and unread folder counts | Complete | Complete | Returned by `list_folders`. |
| Open Inbox, Sent, Drafts, Spam, Trash, and custom folders | Complete | Complete | `list_messages` opens the same account and folder in the UI. |
| Manually refresh the mailbox | Complete | Equivalent | List/search query the synchronized index and report coverage; incomplete coverage uses bounded provider fallback. Full reads request provider data. |
| Detect changed folder counts in the open UI | Complete | Equivalent | Synchronization pushes mailbox-change events to the page, which refetches lists and counts; the UI also polls folder metadata every 15 seconds. An agent can call `list_folders` again. |
| Load more messages | Complete, cursor pages | Complete, cursor pages | `list_messages.cursor` / `search_messages.cursor`; one backend cursor across unified sources. |
| Create provider folders or Gmail labels | Complete | Complete | `create_folder` updates the provider and the open UI. |
| Rename custom provider folders or Gmail labels | Complete | Complete | `rename_folder` preserves an IMAP folder's parent path and updates the open UI. |
| Delete custom provider folders or Gmail labels | Complete | Complete | `delete_folder`; IMAP folders must be empty, while deleting a Gmail label leaves messages in their other labels. System folders are protected. |
| Configure special-folder mappings | Complete | Not covered | Manage folders > Special folders sets Archive, Sent, Drafts, Trash and Spam per IMAP account, or None. Automatic detection uses SPECIAL-USE, then common names in several languages (Sent Items, INBOX.Sent, Verzonden, Prullenbak…). `list_folders` returns the resolved `specialUse` and `specialUseSource`; no WebMCP tool changes the mapping. Gmail labels are fixed. |

## Reading, searching, and presentation

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| List message summaries | Complete | Complete | `list_messages` also shows the same mailbox view in the UI. |
| Read full message bodies | Complete | Complete | `read_messages` |
| Read the whole conversation, including your own replies in Sent and other folders | Complete | Complete | `read_conversation` returns up to 50 messages oldest first with bodies, across accounts. The reader collapses read messages and loads each body when expanded. |
| Group the message list by conversation | Complete | Not covered | **Conversations** in the list header shows one row per conversation in the current view with participants, count, latest snippet and unread state; actions on a row apply to each of its messages in the view. WebMCP list and search tools return individual messages, each with its `conversationId`. |
| Search within a folder | Complete | Complete | `search_messages` writes the query into the UI and shows the matching messages. |
| Search operators (`from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `is:unread`, `is:flagged`, `before:`, `after:`, `in:`, `account:`, quoted phrases, `-` negation) | Complete | Complete | One shared parser; `search_messages.query` takes the same string as the search box. |
| Search every folder of every account | Complete | Complete | **Everywhere** in the list header while searching; agents add `in:anywhere` to the `search_messages` query. Index only, without provider fallback. |
| Filter all, unread, or flagged messages | Complete | Complete | `list_messages.filter` and `search_messages.filter` update the visible UI filter. |
| Sort by newest, oldest, sender, or subject | Complete | Complete | `list_messages.sort` and `search_messages.sort` update the visible UI sort order. |
| Show sender, recipients, Cc, subject, date, and preview | Complete | Complete | Returned by message list and read tools. |
| Show catch-all delivery addresses | Complete | Complete | Returned as `deliveredTo`. |
| Read received attachment content | Complete (download) | Complete | `read_attachment`: text, JSON and XML as text, anything else base64, up to 5 MiB. |
| Render sanitized HTML mail | Complete | Equivalent | WebMCP receives message content rather than rendering it. |
| Block remote images in displayed HTML | Complete | Equivalent | This is a UI privacy control; WebMCP does not load message images. |
| Show plain-text mail | Complete | Complete | Returned by `read_messages`. |
| Preview image and PDF attachments | Complete | Not applicable | PNG, JPEG, GIF, WebP, AVIF and BMP images show inline (up to 8 of at most 10 MB load on their own); PDFs open in a new tab. SVG is never previewed. Bytes come from the attachment download endpoint; no frame or CSP change. `read_messages` already lists attachments. |
| Unsubscribe from a mailing list | Complete | Not available | The reader offers Unsubscribe from `List-Unsubscribe`: RFC 8058 one-click POST, an email from the delivered identity, or opening the link, always after a human confirmation. Agents can see the options in `read_messages` but cannot unsubscribe, because that confirmation cannot pass through WebMCP. |

## Message selection and actions

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Select one message | Complete | Equivalent | Use one stable message reference. |
| Select multiple visible messages | Complete | Complete | `apply_message_actions` accepts up to 100 items. |
| Mark as read | Complete | Complete | `apply_message_actions` with `mark_read`. |
| Mark as unread | Complete | Complete | `apply_message_actions` with `mark_unread`. |
| Archive | Complete | Complete | Move to the account's archive folder. |
| Report spam or mark not spam | Complete | Complete | `apply_message_actions` with `move` to the account's junk folder, or from it to the inbox. The UI offers Spam / Not spam buttons and the `!` shortcut. No `$Junk` keywords are set. |
| Move to another folder | Complete | Complete | `apply_message_actions` with `move`. |
| Move to Trash | Complete | Complete | `apply_message_actions` with `trash`. |
| Permanently delete mail | Partial | Not available | IMAP accounts only: **Delete forever** in the reader and for a selection, plus **Empty Trash** / **Empty Spam**, each after a confirmation dialog, and only for messages in the special-use Trash or Junk folder. Gmail is not supported because Postreeve's `gmail.modify` grant cannot delete; Gmail removes Trash and Spam after 30 days. Deliberately no WebMCP tool or action: the confirmation is human-only. Trash still only moves. |
| Flag or unflag mail | Complete | Complete | `apply_message_actions` with `flag` or `unflag` (IMAP `\Flagged`, Gmail `STARRED`). |

Every WebMCP mutation revalidates the stable message reference, records an audited batch, isolates work to one account, and returns individual success or failure results.

## Composing and sending

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Compose a new plain-text message | Complete | Complete | `send_message` |
| Send from the selected account's primary address | Complete | Complete | `send_message`; the backend uses Gmail API or SMTP according to the account. |
| Send to multiple recipients | Complete | Complete | `send_message.to` accepts up to 100 email addresses. |
| Add Cc recipients | Complete | Complete | `send_message.cc` |
| Add Bcc recipients | Complete | Complete | `send_message.bcc` |
| Validate recipient addresses | Complete | Complete | UI and WebMCP inputs reject invalid addresses. |
| Suggest recipients from mail history | Complete | Not covered | To, Cc and Bcc suggest addresses from synchronized headers across all accounts, ranked by sends, then received mail and recency, without your own addresses. Arrow keys move, Enter or Tab accepts, Escape closes. Local data only; `send_message` takes explicit addresses. |
| Show accepted and rejected recipients | Complete | Complete | Returned in the send receipt. |
| Keep a copy of IMAP/SMTP sends in Sent | Complete | Complete | `send_message` uses the same send path. The per-account **Save a copy to Sent** setting is UI-only and starts off for Gmail and Outlook hosts, which file sent mail themselves. |
| Require approval before an agent sends real mail | Not applicable | Complete contract requirement | The `send_message` description requires explicit approval of recipients, subject, and message before invocation. |
| Reply | Complete | Draft only | Sent with `In-Reply-To` and `References` from the source message; Gmail keeps it in the thread. Agents prepare a reply with `create_draft` mode `reply`; the person sends it. |
| Reply all | Complete | Draft only | Recipients come from the source message; threaded like Reply. `create_draft` mode `reply_all`. |
| Forward | Complete | Draft only | Quotes the source message, including its HTML in rich-text mode. `create_draft` mode `forward`; the agent writes the quote. |
| Send from an alternate identity or catch-all alias | Complete | Draft only | Drafts send from a stored identity over SMTP and Gmail. Gmail requires the address under Send mail as. Replies default to the identity the message was delivered to, including the exact address a wildcard identity covers. `send_message` sends from the primary address only; `create_draft.from` picks an identity by address. |
| Add attachments | Complete | Not available | Files upload into the saved draft on the server and are sent as attachments, within the upload and message size limits. Inline (CID) images are not supported. |
| Compose rich text (bold, italic, links, lists, quotes) | Complete | Not available | Sent as `multipart/alternative`: HTML sanitized by the server against an allowlist plus a generated plain-text part. A plain-text mode remains. `send_message` stays plain text so agent-approved messages are exactly the text the person reviewed. |
| Quote the original HTML in replies and forwards | Complete | Not available | Quoted with the reader's sanitizer; style sheets and remote images are dropped, so composing never fetches remote content. |

Sending is a real external side effect. WebMCP exposes only the narrowest send, a new plain-text message from the primary address; replies, forwards, attachments, drafts and alternate identities stay in the UI. Remote MCP agents cannot send at all.

## Drafts and identities

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Autosave a draft | Complete | Not applicable | Saved to the server with optimistic versions while you type. |
| Create or edit a draft | Complete | Complete | `create_draft`, `update_draft` (version-checked: a newer edit by the person wins). No tool sends a draft. |
| List and reopen drafts | Complete | Complete | `list_drafts`, `read_draft`. Old browser-local drafts migrate once. |
| Delete a draft | Complete | Not available | Also removes its provider copy. |
| Mirror drafts to the provider | Complete | Not available | Each draft is copied to Gmail drafts or the IMAP Drafts mailbox; the Postreeve draft stays authoritative. Drafts created in other clients are not imported. |
| List identities and signatures | Complete | Complete | `list_identities`, `list_signatures` |
| Add or remove an identity | Complete | Not available | Stored per account on the server; browser-local identities migrate once. Compose offers Add as identity for an unregistered Delivered-To address. |
| Wildcard identities for catch-all domains | Complete | Not available | `*@example.com` on IMAP accounts covers every address on exactly that domain: replies leave from the delivered address, and other domains stay refused. |
| Import Gmail Send mail as addresses | Complete | Not available | Imported once when the account connects and again with Import from Gmail in the identity sheet; additive, never removes identities. |
| Select an alternate From identity | Complete | Not available | Sending is disabled for an address that is not an identity of the account. |
| Per-identity signatures | Complete | Not available | One signature per sending address, edited in the identity sheet and stored on the server. A wildcard identity's signature applies to every address it covers without its own. Compose inserts it and swaps it when From changes, unless the signature was edited. |

Agents prepare drafts; only the person sends them, from the compose form.

## Activity and undo

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| View audited mailbox activity | Complete | Complete | `list_activity` |
| Inspect per-message action results | Complete | Complete | Returned in each activity batch. |
| See applied, failed, undone, and partial states | Complete | Complete | Returned batch and operation statuses. |
| Undo supported actions | Complete | Complete | `undo_batch` |
| Undo permanent deletion | Not available | Not available | Permanent deletion cannot be undone, so it records no Activity batch; the confirmation dialog says so. |
| See which agent did what | Complete | Not applicable | Activity names a remote agent on every batch it applied and lists its other calls (reads, proposals, folder changes) from the server's audit. WebMCP and UI batches stay attributed in this browser only. |

## Proposals

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Prepare a set of actions for the person to review | Not applicable | Complete | `create_proposal`; changes no mail. The message list shows `◇ proposes …` on each message. |
| Edit a waiting proposal or move it to review | Not applicable | Complete | `update_proposal`; only `review` is accepted as a status. |
| List proposals | Complete (markers and sidebar counts) | Complete | `list_proposals` |
| Accept (approve and apply) a proposal | Complete | Not available | Only the human UI approves. No WebMCP or remote MCP tool can approve or apply. |
| Decline a proposal | Complete | Not available | **Decline** in the reader strip; the proposal becomes `declined` and stops waiting. No tool declines, so an agent cannot hide its own proposal. |

## Rules and automation

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Create sender, recipient, header, or subject rules | Not available | Not available | No rules engine exists yet. |
| Automatically move incoming mail | Not available | Not available | No background rule execution exists. |
| Automatically forward or redirect mail | Not available | Not available | No forwarding implementation exists. |
| Schedule mailbox work | Not available | Not available | Postreeve currently acts only while the page and user workflow are active. |

## Web app

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Keyboard shortcuts | Complete | Not applicable | `j`/`k`, Enter, Escape, `x`, `e`, `#`, `!`, `u`, Shift+U, `s`, `c`, `r`, `a`, `f`, `/`, `[`, `g` then `i`/`s`/`d`/`t`, ⌘Z/Ctrl+Z, and `?` for a help overlay (also in **Settings → Keyboard shortcuts**). Ignored while typing in any field or the message editor and while a dialog is open. |
| Use on a phone | Complete | Not applicable | At 640 px and below: sidebar drawer, list and reader as separate screens with back (including the browser back gesture), 44 px touch targets, full-screen compose and dialogs, safe-area insets. |
| Install as an app (PWA) | Complete | Not applicable | Web app manifest, icons and a service worker that caches only the app shell, never `/api/` responses or mail. Production builds only; installable from `http://127.0.0.1` or HTTPS. |
| Recover from a display error | Complete | Not applicable | Error boundaries around the app, the reader and compose show the error with Reload and Try again instead of a blank page. |

## Synchronization and retention

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Inspect account synchronization health and retention policy | Complete | Complete | `inspect_synchronization`; reads local evidence. |
| Retry account synchronization safely | Complete | Complete | `retry_synchronization`; does not mutate provider mail. |
| Request human reauthorization instructions | Complete | Complete | `request_reauthorization`; consent and credentials stay in the human authorization flow. |
| Receive new mail promptly | Complete | Not applicable | IMAP accounts hold one IDLE connection on INBOX and synchronize it as soon as the server reports a change, falling back to the 60-second poll without IDLE. Gmail history is polled every 20 seconds. |
| Desktop notifications for new mail | Complete | Not applicable | **Settings → Notifications** turns notifications on and mutes accounts. Unread Inbox arrivals notify while the window is in the background; clicking opens the message. Backfill and repair do not notify. Page-local presentation, not an agent workflow. |
| Bounded preview/body retention | Complete | Complete | Defaults to 365 days since refresh and 64 MiB per account (about 320 MiB of disk per account at the cap). Retained preview and searchable body text expire together. Headers, locations, canonical identities and workflow history remain retained, so recipient suggestions survive preview expiry and disappear only when the message leaves the index or its account is removed; this is not a total database-size limit. |

## Mail server (Stalwart)

The Mail server tools are shared agent tool definitions (`src/server/stalwart/agent-tools.ts`) for the remote agent layer; they are not part of the page's WebMCP tool set below.

| Feature | Web UI | Agent tools | Tool or reason |
| --- | --- | --- | --- |
| Connect, edit and disconnect a Stalwart server | Complete | Not covered | Credentials are entered only by the owner. |
| List domains, mailboxes, aliases, lists and catch-all | Complete | Complete | `list_mail_servers`, `list_mail_server_domains` |
| Add and delete domains, set catch-all | Complete | Proposal only | `propose_mail_server_change`; deletion needs the name typed at approval. |
| Create, edit, delete mailboxes and aliases | Complete | Proposal only | Agents never set passwords; the owner enters them at approval. |
| Add a mailbox as a Postreeve account via app password | Complete | Proposal only | `createMailbox` with `addToPostreeve`. |
| Mailing lists | Complete | Proposal only | |
| DKIM keys | Complete | Proposal only | Private keys are generated in Postreeve, sent to Stalwart once and never stored or returned. |
| DNS checklist with live verification | Complete | Complete | `check_mail_server_dns` |
| Delivery queue: view, retry, cancel | Complete | Partial | `inspect_mail_server_queue`; retry and cancel are proposal operations. |
| Received DMARC and TLS reports | Complete | Not covered | |
| Spam thresholds and trusted/blocked domains | Complete | Proposal only | Threshold changes are proposal operations; list edits are UI only. |
| Approve or reject a mail server proposal | Complete | Not available | Only the human-facing UI approves. |

## Current WebMCP tool set

The following tools are discoverable only while the Postreeve page is open:

1. `list_accounts`
2. `list_folders`
3. `create_folder`
4. `rename_folder`
5. `delete_folder`
6. `list_messages`
7. `read_messages`
8. `search_messages`
9. `send_message`
10. `apply_message_actions`
11. `list_activity`
12. `undo_batch`
13. `inspect_synchronization`
14. `retry_synchronization`
15. `request_reauthorization`
16. `read_conversation`
17. `list_proposals`
18. `create_proposal`
19. `update_proposal`
20. `list_identities`
21. `list_signatures`
22. `list_drafts`
23. `read_draft`
24. `read_attachment`
25. `create_draft`
26. `update_draft`

Calling `list_messages` or `search_messages` updates the open page to the same account, folder, query, filter, sort order, and message results returned to the AI. With no source, they list every account's inbox. Calling a folder-management tool updates the open page's folder list and keeps the selected mailbox valid. A created or updated proposal shows on its messages right away.

The page works the same on a hosted HTTPS origin under the owner's session cookie: its tools call `/api` with same-origin requests and assume nothing about loopback.

## Remote MCP

Agents outside the browser connect to `<origin>/mcp` (Streamable HTTP, stateless JSON). The tool definitions are the page's, from one shared layer; what a remote agent sees depends on the tier the owner granted.

| Tier (scopes) | Tools |
| --- | --- |
| Read only (`mail:read`) | `list_accounts`, `list_folders`, `list_messages`, `search_messages`, `read_messages`, `read_conversation`, `read_attachment`, `list_identities`, `list_signatures`, `list_drafts`, `read_draft`, `list_activity`, `list_proposals`, `inspect_synchronization`, `request_reauthorization` |
| Read and prepare (`+ mail:propose`, `mail:draft`) | adds `create_proposal`, `update_proposal`, `create_draft`, `update_draft` |
| Read, prepare and act (`+ mail:act`) | adds `create_folder`, `rename_folder`, `delete_folder`, `apply_message_actions`, `undo_batch`, `retry_synchronization` |

Remote agents never get `send_message`, unsubscribe, a way to send a draft, or anything that approves, applies or declines a proposal. A grant can be limited to chosen accounts; other accounts are invisible and refused.

| Feature | Status | Notes |
| --- | --- | --- |
| OAuth 2.1 with PKCE, dynamic client registration, metadata discovery | Complete | claude.ai and ChatGPT connectors, Claude Code `--transport http`. |
| Consent with tier and account choice | Complete | Requires the signed-in owner. |
| Refresh token rotation with reuse detection, token revocation | Complete | Access tokens last 1 hour, refresh tokens 30 days. |
| Personal access tokens for CLI agents | Complete | **Settings → Connected agents**; shown once, no expiry, revocable. |
| List connected agents with last use, revoke | Complete | **Settings → Connected agents**. |
| Audit of every remote call | Complete | Shown in Activity under the agent's name; newest 5,000 kept. |
