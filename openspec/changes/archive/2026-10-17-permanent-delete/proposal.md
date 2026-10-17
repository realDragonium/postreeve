# Proposal

## Why

FEATURES.md lists "Permanently delete mail" as Not available. Trash and Spam fill up on IMAP servers that never purge them, and the owner has no way to clear them from Postreeve.

## What Changes

- **Delete forever** for messages in an IMAP account's Trash or Junk folder: `POST /api/messages/delete-permanently` with `{ accountId, messages, confirm: "delete permanently" }`. The server refuses any message outside the account's special-use Trash or Junk folder, revalidates each reference, and expunges only the named UIDs.
- **Empty Trash** and **Empty Spam** for IMAP accounts: `POST /api/accounts/<accountId>/folders/empty` with `{ path, confirm: "delete permanently" }`, allowed only for the special-use Trash or Junk folder.
- Both are destructive, so the UI asks first in a confirmation dialog that names the count and folder and says it cannot be undone. Neither creates an undo entry.
- **Gmail accounts are not supported.** Postreeve's Gmail grant is `gmail.modify`, and Gmail's delete endpoints require the full `https://mail.google.com/` scope. The UI hides the controls for Gmail accounts and explains that Gmail removes Trash and Spam after 30 days. The Gmail provider refuses the call with that explanation.
- **Not exposed to agents**: no WebMCP tool, proposal action or `TriageAction` type can delete permanently. The Trash action keeps meaning "move to Trash".
- FEATURES.md is updated.

## Capabilities

### Modified Capabilities

- `actions/message-actions`: Trash still never deletes; a new, separate, human-only permanent delete and empty-folder path exists for Trash and Junk.
- `agents/webmcp-tools`: no tool deletes permanently.

## Impact

- Shared contracts: two input schemas and a result schema.
- `MailProvider`: optional `deletePermanently` and `emptyFolder`; IMAP implements both, Gmail refuses.
- Sync store: remove the index locations of deleted messages.
- API routes, web API client, Reader, App (folder header control and confirmation dialog). MessageList is left alone (parallel branch).
- No database migration.
