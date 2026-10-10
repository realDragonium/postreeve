# Design

## Context

Compose (`ComposeModal` in `src/web/panels.tsx`) edits a `<textarea>`; drafts store `body` as text; `composeMime` in `src/server/mail/outgoing-content.ts` builds every outgoing MIME message (SMTP send, Gmail send, provider-draft copies) with a single base64 `text/plain` part. The reader renders received HTML in a sandboxed iframe after DOMPurify and remote-resource blocking (`src/web/EmailBody.tsx`). Identities are server-stored per account; the primary address is not an identity row.

## Goals / Non-Goals

**Goals:** basic formatting, HTML quoting, sanitized multipart/alternative output, plain-text mode, per-address signatures, transparent handling of existing drafts.

**Non-Goals:** inline/CID images, pasted or remote images in outgoing mail, fonts/colours/alignment toolbar, rich text for `POST /api/messages/send` and WebMCP, a per-user default compose format, keyboard shortcuts beyond the browser's own.

## Decisions

### Editor: a `contenteditable` element with `document.execCommand`

The toolbar runs `bold`, `italic`, `createLink`, `insertUnorderedList`, `insertOrderedList` and `formatBlock blockquote` through `execCommand`. It is deprecated but implemented by every engine Postreeve targets (Chromium in Electron, Safari, Firefox) and needs no dependency.

Alternatives: ProseMirror/Tiptap or Lexical give better editing semantics but normalize content into their own schema, which would discard the tables and layout of a quoted HTML message — the very thing quoting must keep — and add 100+ KB. A sandboxed iframe editor would isolate quoted styles, but makes focus, accessibility labelling and every e2e test harder; CSS containment on the editor (`contain: content`, `overflow: auto`) keeps quoted `position: fixed` content inside the editor box, and the content is sanitized before it is inserted.

The editor element is a `role="textbox"` with `aria-multiline` and the label `Message`, so existing form semantics (label, disabled state via `aria-disabled` and `contenteditable=false`) carry over.

### Client sanitizing: the reader's rules plus no remote resources

The reader's DOMPurify configuration moves into `src/web/html-sanitizer.ts` and is shared. For compose (`sanitizeComposeHtml`) it additionally forbids `<style>`, removes every `src`/`srcset`/`background` that is not a `data:` URL (a removed image becomes its alt text) and drops CSS declarations containing `url(`. It runs on every HTML that enters the editor: the quoted source, pasted HTML, a reopened draft and signatures. Because nothing remote stays in the DOM, composition never fetches a remote resource.

### Server sanitizing at MIME construction

`composeMime` takes `{ text } | { html }`. For HTML it runs `sanitize-html` with a strict allowlist (text-level formatting, paragraphs, lists, block quotes, headings, `pre`, tables, `a href` limited to `http`, `https`, `mailto` and `tel`, `img` only with `data:image/*`, a short CSS property allowlist without `position` or `url()`), then derives `text/plain` from the sanitized HTML with `html-to-text`, and builds `multipart/alternative`. This is the only place outgoing bytes are produced, so neither drafts sent, provider-draft copies nor any future caller can bypass it. `sanitize-html` is chosen over server-side DOMPurify because it needs no DOM implementation (no jsdom) and is widely maintained; its parser `htmlparser2` and `html-to-text` already ship through `mailparser`.

Drafts store the HTML the client sent (bounded at 2,000,000 characters) rather than sanitized HTML, so a save never changes content under the editor and autosave conflict detection stays exact. The stored HTML is never rendered unsanitized: compose sanitizes on load and the server on output.

### Draft format

`draftContentSchema` gains `format: "plain" | "html"`, default `plain`; the `drafts` table gains `body_format TEXT NOT NULL DEFAULT 'plain'` (migration 480004). Existing drafts and clients that omit `format` stay plain text, which is the transparent migration. Sending a draft validates a non-empty body on the generated plain text, so a rich-text draft containing only markup is refused like an empty one. The draft send path passes `html` to the sender through `OutgoingMessage`, which stays an internal type; `sendMessageInputSchema` is unchanged.

### Plain-text mode

New compose opens in rich-text mode. **Plain text** converts the editor's content with `innerText` (formatting is lost; the button says so); **Rich text** converts text to HTML by escaping and turning lines into `<div>`s. A reopened plain draft opens in plain-text mode.

### Signatures

New table `signatures (tenant_id, account_id, address, html, updated_at)`, primary key `(tenant_id, account_id, address)`. API: `GET /api/accounts/<id>/signatures` → `[{ address, html }]`; `PUT /api/accounts/<id>/signatures` with `{ address, html }` stores it (address must be the primary address or an identity; `html` up to 100,000 characters; blank removes it). Removing an identity or account removes its signatures. One table keyed by address covers the primary address without special-casing the account row.

In rich-text mode compose inserts the signature as `<div data-postreeve-signature>` after an empty first line and before any quote. On a From change it replaces that block's content only when the block still equals what was inserted (compared after browser normalization); an edited signature is left alone. With no block present and a new signature it inserts one before the quote. In plain-text mode the signature is the standard `-- \n` delimiter plus the signature text, swapped by exact match by a pure function (`swapPlainSignature`). A new message whose content is only the inserted signature is not saved as a draft until the user changes something.

## Risks / Trade-offs

- `execCommand` could be removed from browsers some day → the editor is one small component, replaceable without changing the stored format.
- Quoted remote images are dropped from replies and forwards → recipients see the alt text; accepted for privacy and simplicity, noted as a follow-up.
- Allowlist sanitizing can drop styling of complex quoted newsletters → structure and text survive; acceptable for replies.
- Two sanitizers (client DOMPurify, server sanitize-html) can disagree → the server is authoritative; the client one only protects the app's DOM.
