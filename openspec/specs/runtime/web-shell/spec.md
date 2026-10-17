# runtime/web-shell Specification

## Purpose
Covers the web interface as an application: keyboard shortcuts and when they are ignored, the shortcut help, recovery from render errors, the phone layout and touch targets, and installing Postreeve as a web app with a shell-only service worker. Mailbox actions themselves are specified in actions/message-actions; reading in mailbox/message-reading.

## Requirements

### Requirement: Shortcuts ignore typing
Keyboard shortcuts SHALL be ignored when the event target is an `input`, `textarea` or `select`, an element that is content-editable, or an element inside a `role="textbox"` or `contenteditable` element. Escape in such a target SHALL only blur it. Command/Control+Z in such a target SHALL be left to the editor and MUST NOT undo a mailbox action.

#### Scenario: Undo inside the rich-text editor
- **WHEN** a person archives a message, opens compose, types in the message body and presses Control+Z
- **THEN** no undo request is sent and the archived message stays archived

#### Scenario: Letter keys while composing
- **WHEN** a person types `e`, `[` and `j` in the message body
- **THEN** the text is inserted and no mailbox action, sidebar toggle or focus move happens

### Requirement: Dialogs block mailbox shortcuts
While a compose, account, folder, identity or drafts dialog or the shortcut help is open, the interface SHALL ignore every shortcut except Escape closing the shortcut help. Command/Control+Z SHALL NOT undo a mailbox action while a dialog is open.

#### Scenario: Undo key in an open dialog
- **WHEN** the folders dialog is open and focus is on a button and the person presses Command+Z
- **THEN** no undo request is sent

### Requirement: Keyboard shortcuts
Outside typing and dialogs the interface SHALL offer: `j`/Down and `k`/Up next and previous message, Enter open, Escape close the reader, `x` select, `e` archive, `!` spam or not spam, `u` toggle read, `Shift+U` mark unread, `s` toggle flag, `#` move to Trash, `r` reply, `a` reply all, `f` forward, `c` compose, `/` search, `[` toggle the sidebar, Command/Control+Z undo and `?` help. Shortcuts other than undo SHALL be ignored with Command, Control or Alt held.

#### Scenario: Reply from the list
- **WHEN** a person focuses a message in the list and presses `r`
- **THEN** compose opens as a reply to that message

#### Scenario: Modifier held
- **WHEN** a person presses Control+R
- **THEN** the interface does not open a reply

### Requirement: Shortcut targets
Action shortcuts SHALL act on the selection, or else the open or focused message. Reply, reply all and forward SHALL compose from the open or focused message. `#` SHALL do nothing when that message is in Trash or its account has no Trash folder.

#### Scenario: Trash with the keyboard
- **WHEN** a person presses `#` on a focused Inbox message in an account with a Trash folder
- **THEN** the UI sends a `trash` action for that message

### Requirement: Go-to shortcuts
`g` followed within 1.5 seconds by `i`, `s`, `d` or `t` SHALL go to Inbox, Sent, Drafts or Trash in the current account. In the unified view it SHALL switch the unified folder. An account without such a folder SHALL show `This account has no <folder> folder.` A `g` with no target key in time SHALL be dropped.

#### Scenario: Go to Sent
- **WHEN** a person viewing an account's Inbox presses `g` then `s`
- **THEN** the list shows that account's Sent folder

### Requirement: Shortcut help
Pressing `?` SHALL open a dialog titled `Keyboard shortcuts` listing every shortcut and what it does, from the same table the key handler uses. Escape, the close button or a click outside SHALL close it. Settings SHALL offer a control that opens the same dialog.

#### Scenario: Open help
- **WHEN** a person presses `?` in the mailbox
- **THEN** a dialog lists `r` Reply, `#` Move to Trash and `g` then `i` Go to Inbox among the shortcuts

### Requirement: A render error does not blank the interface
The interface SHALL catch render errors at the application shell, the reader pane and the compose dialog. A caught error SHALL show `Something went wrong`, the error's message as plain text and a **Reload** control; the reader and compose fallbacks SHALL also offer **Try again**, which renders the pane again, while the rest of the interface stays usable.

#### Scenario: Reader crash
- **WHEN** rendering an open message throws
- **THEN** the reader pane shows the fallback with the error message, and the message list and sidebar still work

### Requirement: Phone layout
At a viewport width of 640 px or less the interface SHALL show one pane at a time: the sidebar as a drawer over the content that closes on a folder choice or a tap outside it, the message list, or the reader with a back control. Compose and other dialogs SHALL fill the screen, content SHALL stay clear of the device's safe-area insets, and the page SHALL NOT scroll horizontally.

#### Scenario: Full-screen compose on a phone
- **WHEN** a person on a 390 by 844 viewport opens compose
- **THEN** the compose dialog covers the whole viewport

#### Scenario: Drawer on a phone
- **WHEN** a person on a 390 by 844 viewport opens the sidebar and picks a folder
- **THEN** the drawer closes and the list shows that folder

### Requirement: Touch targets
At a viewport width of 640 px or less, and on any device whose primary pointer is coarse, buttons, list rows, folder rows and form fields SHALL be at least 44 px tall.

#### Scenario: Row height on a phone
- **WHEN** the message list renders on a 390 by 844 viewport
- **THEN** each row is at least 44 px tall

### Requirement: Back closes the reader
Opening the reader SHALL add a browser history entry, so the browser's back action closes the reader and returns to the list instead of leaving the app.

#### Scenario: Read and go back on a phone
- **WHEN** a person on a 390 by 844 viewport opens a message and then uses the browser's back action
- **THEN** the list shows again with the app still open

### Requirement: Installable web app
The web interface SHALL publish a web app manifest named `Postreeve` with `display: standalone`, a start URL of `/`, and 192 px, 512 px and maskable icons, plus an Apple touch icon and theme colors. A production build served over `http:` or `https:` SHALL register a service worker at `/sw.js`; the development server and the desktop app SHALL NOT.

#### Scenario: Manifest served
- **WHEN** a browser loads the production interface
- **THEN** the page links `/manifest.webmanifest` and registers `/sw.js`

### Requirement: The service worker caches only the shell
The service worker SHALL cache only same-origin `GET` responses for the application shell: pages, scripts, styles, the manifest and icons. It MUST NOT cache or answer any request under `/api/`, any non-`GET` or cross-origin request, or any response marked `no-store`. Navigations SHALL use the network first and fall back to the cached shell when offline.

#### Scenario: API responses are never cached
- **WHEN** the service worker sees `GET /api/accounts`
- **THEN** it passes the request to the network and stores nothing

#### Scenario: Offline launch
- **WHEN** an installed Postreeve starts while the server is unreachable
- **THEN** the cached shell loads and API requests fail with their normal errors

### Requirement: Brand name
The top bar SHALL show the brand as `POSTREEVE`.

#### Scenario: Top bar
- **WHEN** the interface loads
- **THEN** the top bar reads `POSTREEVE`
