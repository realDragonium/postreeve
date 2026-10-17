# Tasks

## 1. Keyboard bug

- [ ] 1.1 `isTypingTarget` in `src/web/keyboard.ts` with unit tests
- [ ] 1.2 Global handler ignores editable targets and dialogs; e2e regression: Cmd/Ctrl+Z in the rich editor does not undo a mailbox action

## 2. Error boundaries

- [ ] 2.1 `ErrorBoundary` component; wrap shell, reader and compose
- [ ] 2.2 e2e: a reader render crash shows the fallback and the list stays usable

## 3. Shortcuts

- [ ] 3.1 Shortcut table in `keyboard.ts` shared by the handler, help overlay and hint bars
- [ ] 3.2 `r`, `a`, `f`, `c`, `#`, `Shift+U`, `g` chords, `?` overlay
- [ ] 3.3 e2e for the new shortcuts and the help overlay

## 4. Phone layout

- [ ] 4.1 640 px rules, touch targets, full-screen compose and sheets, safe areas, drawer
- [ ] 4.2 Back gesture closes the reader
- [ ] 4.3 e2e at 390x844

## 5. Installable app

- [ ] 5.1 Manifest, icons, `index.html` links
- [ ] 5.2 Shell-only service worker and production-only registration
- [ ] 5.3 Unit test that the worker never caches `/api/`; e2e that the production build serves the manifest and registers the worker

## 6. Attachment preview

- [ ] 6.1 `attachment-preview.ts` allowlist with tests
- [ ] 6.2 Reader inline images and PDF preview; e2e

## 7. Wrap-up

- [ ] 7.1 Brand typo
- [ ] 7.2 FEATURES.md and README
- [ ] 7.3 `bun run verify`, spec validation, e2e
