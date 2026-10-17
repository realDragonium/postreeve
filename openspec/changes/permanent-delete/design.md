# Design

## Decisions

1. **A separate endpoint, not a `TriageAction`.** Actions flow through proposals, which agents create and the WebMCP `apply_message_actions` tool accepts. Adding `delete` there would hand agents a destructive path and break the "every action is undoable" model. A separate route used only by the human UI keeps the approval boundary intact.
2. **Only Trash and Junk.** The server looks up the account's special-use folders and refuses any other mailbox, so a bug or a forged request cannot expunge the Inbox. A person who wants a message gone from Inbox trashes it first.
3. **Explicit `confirm: "delete permanently"` field.** It does not authenticate anything; it makes the request self-describing and stops a generic client from reaching the route by accident. The real guard is the UI dialog.
4. **IMAP expunge is UID-exact.** With `UIDPLUS`, imapflow sends `UID EXPUNGE <uids>`, which removes only those UIDs. Without `UIDPLUS`, plain `EXPUNGE` removes every `\Deleted` message in the folder, so the provider first searches for `\Deleted` messages and refuses if any are not among the targets. Each reference is revalidated (UIDVALIDITY and MODSEQ) before anything is flagged.
5. **Empty folder deletes what is there when it runs.** It reads the folder's UIDs and expunges them in chunks of 500. Mail that arrives in the folder between the confirmation and the request is deleted too; every mail client's Empty Trash behaves the same way, and the confirmation names the folder rather than a fixed list.
6. **Gmail is refused, not faked.** `messages.delete` and `batchDelete` need `https://mail.google.com/`. Widening the grant would force every Gmail account to reauthorize and gives Postreeve full mailbox access for one feature. Gmail already purges Trash and Spam after 30 days.
7. **No Activity record.** Activity holds undoable batches. A permanent delete cannot be undone, so recording it there would offer an Undo that cannot work. The UI shows a status line instead.
8. **Index cleanup.** After the provider confirms, the sync store removes the deleted locations so the list updates at once; the next synchronization snapshot would remove them anyway.
9. **UI placement.** Delete forever sits in the reader toolbar for a message in Trash or Junk. Empty Trash / Empty Spam sits in a strip above the list when an IMAP account's Trash or Junk folder is open; the strip is rendered by `App.tsx` so `MessageList.tsx` (another branch's file) is untouched. Confirmation uses a small in-app dialog with Cancel focused by default.
