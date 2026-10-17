# Proposal

## Why

The owner wants Postreeve as a daily-use web app on desktop and phone. A code audit found a bug that loses mailbox work and several gaps that block daily use:

- The global key handler only treats `INPUT`, `TEXTAREA` and `SELECT` as typing. The rich-text editor is a `contentEditable` div, so Ctrl/Cmd+Z while composing runs `undoLast()` and silently reverts the last mailbox action, and `[`, `j`, `e` and the rest fire while typing.
- One render error blanks the whole interface.
- Reply, forward, compose and folder navigation have no shortcuts, and no shortcut list exists.
- On a phone the sidebar, list and reader share one 900 px breakpoint; targets are 24-26 px tall, compose is a centered sheet, and safe-area insets are ignored.
- Postreeve cannot be installed to a phone's home screen.
- Image and PDF attachments can only be downloaded.
- The top bar says `PORTREEVE`.

## What Changes

- **Typing detection**: shortcuts ignore any editable target (`input`, `textarea`, `select`, `contentEditable`, `role="textbox"`), and every single-key shortcut is ignored while a dialog is open. Cmd/Ctrl+Z inside an editor stays the editor's own undo.
- **Error boundaries** around the app shell, the reader pane and the compose dialog. A crash shows the error message as text with **Reload** (and **Try again** for a pane) instead of a blank page.
- **Shortcuts**: `r` reply, `a` reply all, `f` forward, `c` compose, `#` trash, `Shift+U` mark unread, `g` then `i`/`s`/`d`/`t` for Inbox/Sent/Drafts/Trash, and `?` for a help overlay listing every shortcut. Existing shortcuts stay.
- **Phone layout** at 640 px and below: the sidebar becomes a drawer, the list and reader are separate screens with a back control, touch targets are at least 44 px, compose and sheets go full screen, and the layout respects safe-area insets.
- **Installable web app**: a web app manifest, icons and a service worker that caches only the app shell (HTML, scripts, styles, icons) and never `/api/` responses or mail data. It registers only in production builds served over HTTP(S), not in the desktop app.
- **Attachment preview**: image attachments (PNG, JPEG, GIF, WebP, AVIF, BMP) up to 10 MB show inline below the attachment list; PDFs get **Preview**, which opens the file in a new tab. No server or CSP change.
- The brand reads `POSTREEVE`.
- WebMCP: unchanged. These are presentation and input changes; no mailbox workflow is added.

## Capabilities

### New Capabilities

- `runtime/web-shell`: keyboard shortcuts and typing detection, the shortcut help overlay, error boundaries, the phone layout and the installable web app.

### Modified Capabilities

- `mailbox/message-reading`: the reader previews image and PDF attachments.
- `actions/message-actions`: the action-controls requirement lists the new `#` and `Shift+U` shortcuts.

## Impact

- Web: `App.tsx`, `Reader.tsx`, `main.tsx`, `styles.css`, new `ErrorBoundary.tsx`, `ShortcutHelp.tsx`, `keyboard.ts`, `attachment-preview.ts`, `pwa.ts`.
- Static files in `public/`: manifest, service worker, icons. `index.html` links them.
- `playwright.config.ts` accepts `PLAYWRIGHT_CHROMIUM_EXECUTABLE` so the suite runs against a preinstalled browser.
- No server, schema, CSP or WebMCP change.
- Linear issue: none named for this run.
