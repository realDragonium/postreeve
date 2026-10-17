# Tasks

## 1. Keyboard bug

- [x] 1.1 `isTypingTarget` in `src/web/keyboard.ts` with unit tests
- [x] 1.2 Global handler ignores editable targets and dialogs; e2e regression: Cmd/Ctrl+Z in the rich editor does not undo a mailbox action

## 2. Error boundaries

- [x] 2.1 `ErrorBoundary` component; wrap shell, reader and compose
- [x] 2.2 e2e: a reader render crash shows the fallback and the list stays usable

## 3. Shortcuts

- [x] 3.1 Shortcut table in `keyboard.ts` shared by the handler, help overlay and hint bars
- [x] 3.2 `r`, `a`, `f`, `c`, `#`, `Shift+U`, `g` chords, `?` overlay
- [x] 3.3 e2e for the new shortcuts and the help overlay

## 4. Phone layout

- [x] 4.1 640 px rules, touch targets, full-screen compose and sheets, safe areas, drawer
- [x] 4.2 Back gesture closes the reader
- [x] 4.3 e2e at 390x844

## 5. Installable app

- [x] 5.1 Manifest, icons, `index.html` links
- [x] 5.2 Shell-only service worker and production-only registration
- [x] 5.3 Unit test that the worker never caches `/api/`; e2e that the production build serves the manifest and registers the worker

## 6. Attachment preview

- [x] 6.1 `attachment-preview.ts` allowlist with tests
- [x] 6.2 Reader inline images and PDF preview; e2e

## 7. Wrap-up

- [x] 7.1 Brand typo
- [x] 7.2 FEATURES.md and README
- [x] 7.3 `bun run verify`, spec validation, e2e
