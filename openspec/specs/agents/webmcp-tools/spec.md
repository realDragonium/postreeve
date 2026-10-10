# WebMCP Tools Specification

## Purpose
Covers the page-scoped WebMCP tools through which an agent in a WebMCP-capable browser works with the open Postreeve page: which tools exist, their inputs, limits and outputs, how they keep the visible UI in step, and how a person controls which tools are offered. The behavior behind each tool is specified with its capability: mailbox/folders, mailbox/message-listing, mailbox/message-reading, compose/sending, actions/message-actions and actions/activity-undo. Proposals (actions/proposals) have no tools.

## Requirements

### Requirement: Tools exist only while the page is open
The web page SHALL register its tools with `document.modelContext`, or `navigator.modelContext` when the document offers none, and SHALL withdraw them through the registration's abort signal when the page unloads or the exposed set changes. When neither context exists, the page SHALL register nothing. The server SHALL offer no MCP endpoint of its own, so the tools are discoverable only while a Postreeve page is open.

#### Scenario: Browser without WebMCP
- **WHEN** the page loads in a browser with no `modelContext`
- **THEN** no tool is registered and the page works normally

#### Scenario: Page closed
- **WHEN** the person closes the Postreeve page
- **THEN** its tools are no longer available to the agent

### Requirement: Fixed tool set without proposal tools
The system SHALL define exactly fifteen page tools: the twelve mailbox tools below plus `inspect_synchronization`, `retry_synchronization` and `request_reauthorization`. Inspection tools SHALL have `readOnlyHint: true`; mutation and recovery request tools SHALL have `readOnlyHint: false`. All SHALL have `untrustedContentHint: true`. No tool SHALL create, update, approve or apply a proposal.

#### Scenario: Agent inspects available tools
- **WHEN** an agent lists the tools of an open Postreeve page with nothing hidden
- **THEN** it sees `list_accounts`, `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `list_messages`, `read_messages`, `search_messages`, `send_message`, `apply_message_actions`, `list_activity`, `undo_batch`, `inspect_synchronization`, `retry_synchronization` and `request_reauthorization`, and no proposal tool

### Requirement: WebMCP mirrors user workflows
Every tool SHALL perform an operation a person can perform in the web UI, through Postreeve's server API, and SHALL NOT introduce an agent-only workflow or capability. Where the UI can do more than a tool, the tool SHALL offer the narrower operation rather than a different one.

#### Scenario: No agent-only operation
- **WHEN** an agent looks for a way to change mail that the UI does not offer, such as permanent deletion
- **THEN** no tool provides it

### Requirement: The person controls which tools are offered
The UI SHALL list every tool with its effect (`read`, `write`, `write · destructive` for `delete_folder`, `write · undoable` for `apply_message_actions` and `undo_batch`, `irreversible` for `send_message`) under Settings › Assistant control, and let the person expose or hide each one. A change SHALL re-register the tools immediately with only the exposed ones, and the hidden set SHALL persist in the browser's local storage.

#### Scenario: Hide send_message
- **WHEN** a person hides `send_message`
- **THEN** the page re-registers its tools without `send_message`, and it stays hidden after a reload

### Requirement: Strict inputs and validated outputs
Each tool SHALL publish its input as a JSON Schema (draft 2020-12), SHALL reject input that does not match it, including unknown properties, without calling the server, and SHALL validate its result against the shared contract before returning it. Each tool SHALL pass the agent's cancellation signal to the request it makes.

#### Scenario: Unknown property
- **WHEN** an agent calls `list_folders` with `{ accountId, extra: true }`
- **THEN** the call fails and no request is sent

### Requirement: Account and folder tools
`list_accounts` SHALL take `{}` and return the accounts; `list_folders` SHALL take `{ accountId }` and return the account's folders with unread and total counts. `create_folder` (`{ accountId, name }`), `rename_folder` (`{ accountId, path, name }`) and `delete_folder` (`{ accountId, path }`), with `name` 1 to 200 trimmed characters and `path` up to 1000, SHALL return the updated folder list. `delete_folder`'s description SHALL require explicit approval of the exact account and folder.

#### Scenario: Create a folder
- **WHEN** an agent calls `create_folder` with `{ accountId, name: "Projects" }`
- **THEN** the result is the account's folder list including `Projects`

### Requirement: Folder tools update the open page
After `create_folder`, `rename_folder` or `delete_folder` succeeds, the open page SHALL show the returned folder list for that account, keep the selected folder when it still exists and otherwise select the account's inbox (or its first folder), close the reader, clear the selection and show `WebMCP updated the folder list.`

#### Scenario: Selected folder deleted
- **WHEN** an agent deletes the folder the person is viewing
- **THEN** the page switches to that account's inbox and shows `WebMCP updated the folder list.`

### Requirement: Listing and searching messages
List/search tools SHALL accept account/mailbox or explicit unified sources, limit 1–100 (default 50), filter, sort and an optional cursor; search also requires literal query text up to 200 characters. They SHALL return validated page envelopes containing canonical messages, nextCursor and synchronization/content/fallback coverage. Descriptions SHALL identify email as untrusted and body search as bounded.

#### Scenario: Unread oldest first
- **WHEN** an agent searches invoice with Unread and Oldest
- **THEN** the backend returns unread matches oldest first before limiting the page

#### Scenario: Continue search
- **WHEN** an agent sends the previous nextCursor with the same search scope
- **THEN** it receives the next backend page in the same explicit order

#### Scenario: Limit above 100
- **WHEN** limit 101 is supplied
- **THEN** the tool rejects the call before server access

### Requirement: Listing and searching update the open view
The page SHALL show the same messages, selected sources, query, filter, sort and continuation/coverage returned to the agent. A fresh query SHALL close the reader and clear selection. Cursor continuation SHALL preserve already displayed pages for the same query.

#### Scenario: Agent searches
- **WHEN** an agent searches a mailbox for invoice with Unread
- **THEN** the UI shows that search and coverage with the same continuation

### Requirement: Reading messages
`read_messages` SHALL take `{ messages }` with 1 to 100 stable message references and return the full canonical message details, including text, HTML and received-attachment metadata, without changing the visible view or the messages' read state.

#### Scenario: Read two messages
- **WHEN** an agent reads two references from a listing
- **THEN** it receives both messages' bodies and the page view is unchanged

### Requirement: Sending a new message
`send_message` SHALL take `{ accountId, to, cc, bcc, subject, text }` with `to` 1 to 100 email addresses, `cc` and `bcc` up to 100 each (default empty), `subject` up to 998 characters and `text` 1 to 2,000,000 characters. It SHALL immediately send a new plain-text message from the account's primary address through `POST /api/messages/send` and return the send receipt with `accepted` and `rejected` recipients.

#### Scenario: Invalid recipient
- **WHEN** an agent calls `send_message` with `to: ["not-an-address"]`
- **THEN** the call fails and nothing is sent

### Requirement: Sending requires explicit approval and stays narrow
The `send_message` description SHALL state that it sends real mail and must only be called after the person explicitly approves the recipients, subject and message. The tool SHALL NOT send replies, reply-all, forwards, attachments, drafts or mail from another identity, even where the UI can (compose/sending, compose/drafts).

#### Scenario: Reply requested
- **WHEN** an agent wants to reply to a message
- **THEN** no tool input expresses a reply, and `send_message` can only send a new message

#### Scenario: Approved send
- **WHEN** the person approves a message and the agent calls `send_message`
- **THEN** the message is sent from the account's primary address and the receipt lists accepted and rejected recipients

### Requirement: Mailbox action tool
`apply_message_actions` SHALL take `{ accountId, items }` with 1 to 100 items of `{ message, subject, action }`, where `action` is `move` (with `destination`), `trash`, `mark_read`, `mark_unread`, `flag` or `unflag`; `leave` SHALL be rejected. It SHALL apply them immediately as a direct action (actions/message-actions) and return the batch with each item's result; the page SHALL attribute the batch to the assistant. Its description SHALL state that Trash never permanently deletes.

#### Scenario: Mixed result
- **WHEN** an agent trashes two messages and one is stale
- **THEN** the tool returns a `partially_applied` batch with one `applied` and one `failed` result

#### Scenario: Leave action
- **WHEN** an agent calls `apply_message_actions` with action `{ type: "leave" }`
- **THEN** the call fails and no request is sent

#### Scenario: Flag for follow-up
- **WHEN** an agent calls `apply_message_actions` with action `{ type: "flag" }` for a current message
- **THEN** the message is flagged and the returned batch is `applied`

### Requirement: Activity and undo tools
`list_activity` SHALL take `{ accountId }` and return the account's operation batches with per-operation results and statuses. `undo_batch` SHALL take `{ batchId }`, undo the batch as specified in actions/activity-undo and return the updated batch.

#### Scenario: Undo an agent action
- **WHEN** an agent calls `undo_batch` with the ID returned by `apply_message_actions`
- **THEN** the returned batch's status is `undone` or `partially_undone`

### Requirement: Synchronization tools
`inspect_synchronization` SHALL accept an empty object and return current local account health and retention policy. `retry_synchronization` and `request_reauthorization` SHALL accept an account ID. Retry SHALL schedule safe background work without changing mail; reauthorization SHALL return human authorization instructions and SHALL NOT receive credentials or grant consent. These tools SHALL validate strict inputs and shared outputs and pass cancellation signals to their API requests.

#### Scenario: Agent requests authorization recovery
- **WHEN** an agent requests reauthorization for an account
- **THEN** it receives instructions for the person to use existing Gmail consent or IMAP account settings, without any credential being exposed
