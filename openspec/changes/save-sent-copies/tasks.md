# Tasks

## 1. Message-ID and sender result

- [ ] 1.1 Add `outgoingMessageId(fromAddress)` to `outgoing-content.ts` and use it in `smtp.ts` and `gmail.ts`; verify with SMTP and Gmail tests asserting `@<sender domain>>`, including an upper-case domain.
- [ ] 1.2 Change `MailSender.send` to return `SentMessage { receipt, mime }` from SMTP, Gmail and the test sender; verify with `bun run typecheck` and an SMTP test that the returned MIME equals the transmitted `raw`.

## 2. Setting

- [ ] 2.1 Add `defaultSaveSentCopy(imapHost)` in `src/shared`, optional `saveSentCopy` in stored SMTP settings, create and update inputs, and required `saveSentCopy` in account settings; round-trip it through `PostreeveService` with host fallback; verify with core tests for default, override, omitted-on-update and legacy accounts.
- [ ] 2.2 Add the **Save a copy to Sent** checkbox to the outgoing-mail section of the account sheet, following the host default until edited; verify with typecheck and build.

## 3. Append and index

- [ ] 3.1 Implement `ImapMailProvider.appendSentMessage` (special-use Sent, `\Seen`, send date, summary via UIDPLUS) on the optional `MailProvider` method; verify with IMAP compatibility tests for append-with-UID, append-without-UID and no Sent mailbox.
- [ ] 3.2 After dispatch in `PostreeveService`, append when the setting is on and a recipient accepted, observe the returned summary, and turn failures into the receipt warning; make the test provider implement the method from the transmitted MIME; verify with core tests for listed-in-Sent-and-conversation, setting off, append failure on a draft send and all-rejected.

## 4. Documentation and verification

- [ ] 4.1 Update README and FEATURES.md rows for sent copies, the setting and Message-IDs; verify by reading the rendered rows.
- [ ] 4.2 Run `bun run typecheck`, `bun run test`, `bun run build`, `bunx openspec validate --specs --strict` and, when a browser is available, `bun run test:e2e`.

## Workflow follow-up

- Archive the change with `/opsx:archive` in the same branch, rebase on `origin/main`, open a PR against `main`.
