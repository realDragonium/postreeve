# Proposal

## Why

Postreeve is meant to replace Apple Mail as a daily driver for a person with many addresses. Two everyday triage steps are missing. There is no Spam / Not spam action, so junk has to be moved by hand through the Move menu. Postreeve also ignores `List-Unsubscribe`, so leaving a mailing list means hunting for a link in the message body.

## What Changes

- **Spam and Not spam** become direct UI actions, and like Archive they are moves to a special folder. Spam moves the message to the account's folder whose `specialUse` is `junk` (IMAP `\Junk`, Gmail `SPAM`). Not spam moves a message out of that folder to the inbox. Batches are audited, report per-item results and can be undone like any other move. No new action type is introduced.
- Gmail: moving to `SPAM` also removes the `INBOX` label, as archiving does. Not spam adds `INBOX` and removes `SPAM`.
- UI: the reader and the selection toolbar get a Spam button, which reads Not spam when the message is in the junk folder. The Spam button is disabled with `This account has no Junk folder` when the account has no junk folder. The `!` shortcut toggles Spam and Not spam.
- **Unsubscribe**: reading a message parses `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) into unsubscribe options on the message detail. The reader shows an Unsubscribe button when options exist. Every unsubscribe requires a human confirmation dialog that names the target.
  - RFC 8058 one-click: the server re-reads the message and sends the one-click HTTPS POST itself, with SSRF guards. It follows no redirects and sends no cookies or credentials, and the request has a timeout.
  - `mailto:`: the server sends the unsubscribe message through the existing send path, from the identity the message was delivered to.
  - Plain HTTPS link: after confirmation, the link opens in a new browser tab. The server is not involved.
- WebMCP: `apply_message_actions` already accepts `move`; its description now says how to report spam or mark mail as not spam. Unsubscribe is **not** exposed to agents because no WebMCP path can carry the human confirmation. `read_messages` returns the parsed options, so an agent can point the person to the button.
- Unsubscribe is not recorded in Activity, because Activity holds undoable mailbox batches and an unsubscribe cannot be undone. A `mailto:` unsubscribe leaves its normal Sent copy.
- FEATURES.md is updated.

## Capabilities

### New Capabilities

- `actions/unsubscribe`: Unsubscribing from a mailing list from the reader, through RFC 8058 one-click, `mailto:` or an opened link, always after human confirmation.

### Modified Capabilities

- `actions/message-actions`: Spam / Not spam as moves to and from the junk folder, with UI controls, the `!` shortcut and Gmail `INBOX` handling.
- `mailbox/message-reading`: Message details carry parsed `List-Unsubscribe` options.
- `agents/webmcp-tools`: `apply_message_actions` describes spam handling; unsubscribe is deliberately not a tool.

## Impact

- Shared contracts: an `unsubscribe` field on message detail and an unsubscribe request and result.
- IMAP and Gmail read paths.
- Gmail move label handling.
- Core service: a new `unsubscribe` method, a new `POST /api/messages/unsubscribe` route, and an injectable fetch for one-click so tests use doubles.
- Web: Reader, MessageList and the App shortcut.
- WebMCP tool description and FEATURES.md.
- No database migration.
- Linear issue: none named for this run.
