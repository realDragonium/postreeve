## 1. Contracts and storage

- [ ] 1.1 Add `format` to draft content, signature schemas and types to shared contracts
- [ ] 1.2 Store `body_format` on drafts (migration 480004) and copy it with recovery copies
- [ ] 1.3 Add the `signatures` table with list, upsert and removal on identity/account removal

## 2. Outgoing HTML

- [ ] 2.1 Add `sanitize-html` and `html-to-text`; implement `sanitizeOutgoingHtml` and `htmlToPlainText` with focused tests
- [ ] 2.2 Make `composeMime` take `{ text } | { html }` and build sanitized multipart/alternative; update SMTP, Gmail and provider-draft callers
- [ ] 2.3 Send rich-text drafts with generated text and HTML; refuse markup-only bodies

## 3. Signatures API

- [ ] 3.1 Add service methods and `GET`/`PUT /api/accounts/<id>/signatures` with tests
- [ ] 3.2 Add web API client methods

## 4. Web compose

- [ ] 4.1 Extract the reader's sanitizer; add `sanitizeComposeHtml` and HTML quote builders
- [ ] 4.2 Rich-text editor component with toolbar, paste sanitizing and disabled state
- [ ] 4.3 Compose form: format toggle, HTML quoting, signature insertion and swapping, pristine new message not saved
- [ ] 4.4 Pure plain-text signature helpers with tests
- [ ] 4.5 Signature editors in the identity sheet

## 5. Verification and docs

- [ ] 5.1 Update e2e tests for the rich-text editor and add a signature/formatting flow
- [ ] 5.2 Update FEATURES.md
- [ ] 5.3 Run typecheck, unit tests, build, spec validation and e2e
