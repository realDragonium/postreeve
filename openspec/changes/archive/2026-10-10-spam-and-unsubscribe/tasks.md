# Tasks

## 1. Spam / Not spam

- [x] 1.1 Gmail: moving to `SPAM` also removes `INBOX`; add a gmail test
- [x] 1.2 Add `spamAction` helper in `src/web/mail-view.ts` with unit tests
- [x] 1.3 Reader and MessageList Spam / Not spam buttons; `!` shortcut in App.tsx; hint bars and Settings shortcut list
- [x] 1.4 WebMCP `apply_message_actions` description mentions spam / not spam

## 2. Unsubscribe parsing

- [x] 2.1 `unsubscribeOptionsSchema` and optional `unsubscribe` on message detail in contracts
- [x] 2.2 Pure `unsubscribeOptions(headerLines)` in `src/server/mail/unsubscribe.ts` with tests
- [x] 2.3 Attach options in IMAP and Gmail `toDetail`

## 3. Unsubscribe execution

- [x] 3.1 One-click guarded POST (`postOneClickUnsubscribe`) with injectable fetch and tests (private host, redirect, non-2xx, request shape)
- [x] 3.2 `mailtoUnsubscribe` parsing with tests
- [x] 3.3 Move `defaultFromAddress`/`ownAddresses` into `src/shared/identities.ts`
- [x] 3.4 `PostreeveService.unsubscribe` and `POST /api/messages/unsubscribe`; core test for method-not-offered and mailto-from-identity
- [x] 3.5 Web api client and Reader Unsubscribe button with confirmation

## 4. Docs and verification

- [x] 4.1 FEATURES.md rows for Spam / Not spam and Unsubscribe
- [x] 4.2 typecheck, test, build, `openspec validate --specs --strict`, e2e if a browser is available
