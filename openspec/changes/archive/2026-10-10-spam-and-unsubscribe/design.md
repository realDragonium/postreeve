# Design

## Context

Archive is already a `move` to the folder whose `specialUse` is `archive`, and that move flows through the direct-action proposal, audited batch, undo and WebMCP `apply_message_actions` paths. Both providers already classify a junk folder: IMAP maps `\Junk` to `junk`, and Gmail maps `SPAM` to `junk`. Message reading parses header blocks with mailparser for both providers. The account discovery code already fetches untrusted HTTPS URLs with `redirect: "manual"`, `credentials: "omit"`, a timeout and a public-DNS-name check.

## Goals / Non-Goals

**Goals:** add Spam and Not spam with minimal new mechanism; add a safe, human-confirmed unsubscribe.

**Non-goals:**
- IMAP `$Junk` and `$NotJunk` keywords.
- Recording unsubscribes in Activity.
- An agent unsubscribe tool.
- Verifying the DKIM coverage that RFC 8058 expects.
- A per-account choice of junk folder.

## Decisions

1. **Spam is a move, not a new action type.** It reuses revalidation, per-item results, the audit trail, undo and WebMCP unchanged, and it mirrors Archive. A dedicated `spam` type would duplicate move semantics across contracts, both providers, undo and the WebMCP schema without a concrete gain.
2. **No `$Junk`/`$NotJunk` keywords.** Servers that learn from user actions (Dovecot imapsieve, Fastmail, Gmail) learn from the move into or out of Junk. Keywords would need a PERMANENTFLAGS check and undo bookkeeping. This can be revisited if a server needs them.
3. **Gmail `SPAM` handling.** Moving to `SPAM` removes `INBOX` in the same way the archive destination does, so a message no longer appears in both places. Undo restores the previous label as it does for other moves.
4. **The UI chooses the destination.** A pure helper (`spamAction`) returns a move to the junk folder, a move from junk to the inbox, or null when no junk folder exists. The Reader, MessageList and the `!` key all use it. `!` follows Gmail's convention, and the existing handler already ignores Command, Control and Alt.
5. **Unsubscribe options are parsed at read time** from the raw header lines by a pure `unsubscribeOptions` function. Raw lines are used because mailparser rewrites `List-*` headers into its own structure. The result is an optional `unsubscribe` field on the message detail, so nothing is persisted and no migration is needed.
6. **The server never trusts a client URL.** `POST /api/messages/unsubscribe` takes `{ message, method }` and re-reads the message through `readMessages`, which also revalidates the reference. It acts only on that message's own header options. A plain link-only option is handled entirely in the browser with `window.open(url, "_blank", "noopener,noreferrer")` after confirmation.
7. **One-click guard.** The guard reuses the discovery approach and exports its DNS-name check. It accepts only `https:` URLs with no user info and the default port, and it refuses hosts that are IP literals, single-label names or `.localhost` names. The request is `fetch` with `redirect: "manual"`, `credentials: "omit"`, a 10 s timeout and the RFC 8058 form body. The body is cancelled unread, so no response size is accepted. The fetch function is injected through `PostreeveContext.unsubscribeFetch` (default: global `fetch`), so tests and e2e fixtures use doubles. Remaining risk: DNS can still resolve a public-looking name to a private address. Discovery has the same limitation.
8. **Mailto send path.** The message goes through `#prepareMessageSend` and `#dispatchMessageSend`, so it gets normal sending, the Sent copy and receipts. From is chosen by `defaultFromAddress`, moved into `src/shared/identities.ts` so the server and web share it, and then resolved through the stored identities.
9. **Confirmation dialog.** The app has no modal component, so the confirmation uses `window.confirm` with the exact action text. This is a human-only gate that WebMCP cannot reach.
10. **No Activity record.** Activity models undoable mailbox batches, and an unsubscribe has no undo or batch shape. The UI shows a status line, and a `mailto:` unsubscribe leaves a Sent copy.

## Risks / Trade-offs

- A cross-account selection in the unified view uses the first message's account to choose the junk path, the same limitation the `e` shortcut has.
- RFC 8058 one-click POSTs are performed without checking the DKIM signature over the header. Spoofed list mail could make Postreeve POST to an attacker-chosen public HTTPS URL, but only after the person confirms a dialog that shows the host.
