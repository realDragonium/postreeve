# Proposal

## Why

Postreeve is meant to replace Apple Mail for a person who receives mail at many addresses, including aliases and catch-all addresses. Today identities live only in one browser's local storage, and every message is sent from the account's primary address; drafts with another identity are refused. Replies to mail received at an alias therefore go out from the wrong address.

## What Changes

- Sender identities (display name and address) are stored on the server per account, with list, add and remove endpoints, and are removed with their account.
- The existing identity sheet and the compose From selector use the server identities; identities kept in browser storage migrate to the server once.
- Sending a draft (new, reply, reply-all, forward) uses the draft's identity as From and, over SMTP, as the envelope sender. The identity must be the account's primary address or one of its stored identities. Provider Drafts-folder copies already carry the draft identity as From.
- Gmail accepts an alternate From only for its verified **Send mail as** addresses. Postreeve reads them through the Gmail `settings/sendAs` API, which the existing `gmail.modify` scope allows, and refuses an unverified address before dispatch with an actionable message.
- Reply, reply-all and forward forms default From to the identity the source message was delivered to (Delivered-To, then To, then Cc), and replies no longer address any of the user's own identities.
- `POST /api/messages/send` and the WebMCP `send_message` tool keep sending only from the primary address. Alternate identities are a human compose workflow; agents/webmcp-tools does not change.

## Capabilities

### New Capabilities

- `compose/identities`: Per-account sender identities stored on the server, their management in the web interface and the one-time migration of browser-local identities.

### Modified Capabilities

- `compose/sending`: Mail is sent from the draft's identity when it belongs to the account; Gmail restricts it to verified Send-as addresses.
- `compose/drafts`: Draft send validation accepts stored identities; compose modes default From to the identity the source was delivered to.

## Impact

Shared contracts, SQLite store (new `identities` table), core send preparation, SMTP and Gmail senders, HTTP API, web identity sheet, compose form, migration helper and FEATURES.md. The parallel sent-copies change derives the Message-ID domain from the From address; this change makes the resolved identity the sender's From. Linear issue: none named for this run.
