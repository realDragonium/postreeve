# Postreeve feature and WebMCP coverage

This document tracks what a person can currently do in Postreeve's web interface and whether the same capability is available through page-scoped WebMCP.

WebMCP follows one product rule: it mirrors user mailbox workflows and must not introduce a separate agent-only workflow. A missing WebMCP capability in this document describes the current implementation, not a decision that the gap should remain.

## Status legend

| Status | Meaning |
| --- | --- |
| Complete | Works end to end against the configured mail provider. |
| Partial | The UI exists, but some state is local-only or provider behavior is unavailable. |
| Not available | The capability is not implemented. |
| Not covered | The capability works in the UI, but no matching WebMCP tool exists today. |
| Equivalent | WebMCP can achieve the same result without a dedicated tool. |

## Accounts

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| List configured accounts | Complete | Complete | `list_accounts` |
| Switch the active account | Complete | Equivalent | Tools accept an explicit `accountId`; no global active-account state is needed. |
| Use multiple Gmail and IMAP/SMTP accounts | Complete | Complete | All mailbox tools are scoped by `accountId`. |
| Connect Gmail through Google OAuth | Complete | Not covered | No matching WebMCP tool exists. The current UI uses an interactive Google login and consent flow. |
| Add an IMAP/SMTP account | Complete | Not covered | No matching WebMCP tool exists. |
| Test IMAP and SMTP settings | Complete | Not covered | No matching WebMCP tool exists. |
| Update or reconnect an IMAP/SMTP account | Complete | Not covered | No matching WebMCP tool exists. |
| Reauthorize Gmail | Complete | Not covered | No matching WebMCP tool exists. The current UI uses an interactive Google consent flow. |
| Remove an account and its local history | Complete | Not covered | No matching WebMCP tool exists. Removing an account through the UI never deletes provider mail. |

## Folders and mailbox navigation

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| List folders | Complete | Complete | `list_folders` |
| Show total and unread folder counts | Complete | Complete | Returned by `list_folders`. |
| Open Inbox, Sent, Drafts, Spam, Trash, and custom folders | Complete | Complete | `list_messages` opens the same account and folder in the UI. |
| Manually refresh the mailbox | Complete | Equivalent | Each WebMCP list, read, or search call requests current provider data. |
| Detect changed folder counts in the open UI | Complete | Equivalent | The UI polls folder metadata; an agent can call `list_folders` again. |
| Load more messages | Complete, up to 100 | Complete, up to 100 | `list_messages.limit` |
| Create provider folders | Partial | Not available | The UI can only plan a folder name locally. |
| Rename provider folders | Partial | Not available | The rename control is disabled pending provider support. |
| Delete provider folders | Not available | Not available | No provider implementation exists. |
| Configure special-folder mappings | Partial | Not available | The current UI is a preview and does not save changes. |

## Reading, searching, and presentation

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| List message summaries | Complete | Complete | `list_messages` also shows the same mailbox view in the UI. |
| Read full message bodies | Complete | Complete | `read_messages` |
| Search within a folder | Complete | Complete | `search_messages` writes the query into the UI and shows the matching messages. |
| Filter all, unread, or flagged messages | Complete | Complete | `list_messages.filter` and `search_messages.filter` update the visible UI filter. |
| Sort by newest, oldest, sender, or subject | Complete | Complete | `list_messages.sort` and `search_messages.sort` update the visible UI sort order. |
| Show sender, recipients, Cc, subject, date, and preview | Complete | Complete | Returned by message list and read tools. |
| Show catch-all delivery addresses | Complete | Complete | Returned as `deliveredTo`. |
| Render sanitized HTML mail | Complete | Equivalent | WebMCP receives message content rather than rendering it. |
| Block remote images in displayed HTML | Complete | Equivalent | This is a UI privacy control; WebMCP does not load message images. |
| Show plain-text mail | Complete | Complete | Returned by `read_messages`. |

## Message selection and actions

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Select one message | Complete | Equivalent | Use one stable message reference. |
| Select multiple visible messages | Complete | Complete | `apply_message_actions` accepts up to 100 items. |
| Mark as read | Complete | Complete | `apply_message_actions` with `mark_read`. |
| Mark as unread | Complete | Complete | `apply_message_actions` with `mark_unread`. |
| Archive | Complete | Complete | Move to the account's archive folder. |
| Move to another folder | Complete | Complete | `apply_message_actions` with `move`. |
| Move to Trash | Complete | Complete | `apply_message_actions` with `trash`. |
| Permanently delete mail | Not available | Not available | Not implemented. Trash currently means moving to the provider's Trash folder. |
| Flag or unflag mail | Partial | Not available | The UI control is disabled pending provider support. |

Every WebMCP mutation revalidates the stable message reference, records an audited batch, isolates work to one account, and returns individual success or failure results.

## Composing and sending

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Compose a new plain-text message | Complete | Complete | `send_message` |
| Send from the selected account's primary address | Complete | Complete | `send_message`; the backend uses Gmail API or SMTP according to the account. |
| Send to multiple recipients | Complete | Complete | `send_message.to` accepts up to 100 email addresses. |
| Add Cc recipients | Complete | Complete | `send_message.cc` |
| Add Bcc recipients | Complete | Complete | `send_message.bcc` |
| Validate recipient addresses | Complete | Complete | UI and WebMCP inputs reject invalid addresses. |
| Show accepted and rejected recipients | Complete | Complete | Returned in the send receipt. |
| Require approval before an agent sends real mail | Not applicable | Complete contract requirement | The `send_message` description requires explicit approval of recipients, subject, and message before invocation. |
| Reply | Partial | Not available | The editor and quoting UI exist, but sending is blocked until thread headers are supported. |
| Reply all | Partial | Not available | The editor populates recipients, but sending is blocked. |
| Forward | Partial | Not available | The editor builds forwarded content, but sending is blocked. |
| Send from an alternate identity or catch-all alias | Partial | Not available | Identities are local-only and alternate-From sending is blocked. |
| Add attachments | Partial | Not available | The UI records local attachment metadata, but files are not uploaded or sent. |

Sending is a real external side effect. WebMCP exposes the same basic send operation as the UI, but it does not send drafts, replies, forwards, attachments, or alternate identities that the UI itself cannot send.

## Drafts and identities

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Autosave a draft | Partial | Not available | Stored only in this browser's local storage. |
| Manually save a draft | Partial | Not available | Stored only in this browser's local storage. |
| List and reopen local drafts | Partial | Not available | Not synchronized with the provider's Drafts folder. |
| Delete a local draft | Partial | Not available | Local browser state only. |
| Synchronize provider drafts | Not available | Not available | No IMAP or Gmail draft implementation exists. |
| Add or remove a local identity | Partial | Not available | Stored only in local storage. |
| Select an alternate From identity | Partial | Not available | The selector exists, but sending is blocked for alternate identities. |

These features are not provider-backed today. Whether and how they should be exposed through WebMCP remains an open product decision.

## Activity and undo

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| View audited mailbox activity | Complete | Complete | `list_activity` |
| Inspect per-message action results | Complete | Complete | Returned in each activity batch. |
| See applied, failed, undone, and partial states | Complete | Complete | Returned batch and operation statuses. |
| Undo supported actions | Complete | Complete | `undo_batch` |
| Undo permanent deletion | Not available | Not available | Permanent deletion is never performed. |

## Rules and automation

| Feature | Web UI | WebMCP | WebMCP tool or reason |
| --- | --- | --- | --- |
| Create sender, recipient, header, or subject rules | Not available | Not available | No rules engine exists yet. |
| Automatically move incoming mail | Not available | Not available | No background rule execution exists. |
| Automatically forward or redirect mail | Not available | Not available | No forwarding implementation exists. |
| Schedule mailbox work | Not available | Not available | Postreeve currently acts only while the page and user workflow are active. |

## Current WebMCP tool set

The following tools are discoverable only while the Postreeve page is open:

1. `list_accounts`
2. `list_folders`
3. `list_messages`
4. `read_messages`
5. `search_messages`
6. `send_message`
7. `apply_message_actions`
8. `list_activity`
9. `undo_batch`

Calling `list_messages` or `search_messages` updates the open page to the same account, folder, query, filter, sort order, and message results returned to the AI.

The former proposal tools are absent because there is no matching completed user-facing proposal workflow in the current UI.
