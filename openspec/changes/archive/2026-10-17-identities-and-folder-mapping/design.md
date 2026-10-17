# Design

## Context

`folderSchema.specialUse` drives every special-folder decision in the web app (Reader Archive/Spam buttons, Unified view, spam intent). The IMAP provider computes it from LIST flags in `specialUseFor` and separately looks up Sent, Drafts and Trash with the same function. Gmail labels are fixed. Identities are exact addresses in the `identities` table; `defaultFromAddress` and `#draftSender` compare exact strings.

## Decisions

### Special folders

- **Resolution lives in a pure shared function** (`resolveSpecialUses` in `src/shared/special-folders.ts`) that takes LIST entries (path, name, parent, flag-derived role) and the overrides and returns each path's role and source. The IMAP provider runs it for `listFolders`, the Sent/Drafts/Trash lookups and the protected-folder check, so the UI and the server always agree. Tests cover it without IMAP.
- **Precedence per role**: override (path or None) > SPECIAL-USE > name. Overrides are applied first for all roles, so a folder taken by an override loses any other role. An override naming a folder that no longer exists is ignored and that role resolves automatically, so a rename elsewhere does not break the account. None strips the role from every folder, including flagged ones, so the owner can disable a wrong flag (for example a server that flags a shared folder as `\Junk`).
- **SPECIAL-USE keeps marking every flagged folder** (unchanged), but a name match is only considered for a role that no folder is flagged with, and only for a folder that has no role yet. This keeps today's behavior on well-behaved servers.
- **Name matches are restricted** to top-level folders and direct children of INBOX (cPanel/Courier `INBOX.Sent`). `Projects/Archive` is a user folder, not the account archive. Matching is case-insensitive on the folder name. Among several candidates for one role, the earlier name in the role's list wins, then listing order. Lists cover English, Dutch, German, French, Spanish, Italian, Portuguese and Scandinavian names, plus Outlook/Exchange names ("Sent Items", "Deleted Items", "Junk E-mail"). Common words only; obscure locales go through overrides.
- **Name-detected and mapped folders become protected** like flagged ones. Renaming a folder that Postreeve uses as Sent would silently move the role; the owner can set the role to None first if they want to rename it.
- **Gmail has no overrides**: its system labels always exist. `PUT` on a Gmail account answers 400.
- **Storage**: new table `folder_mappings(tenant_id, account_id, role, path NULL, updated_at)` keyed by `(tenant_id, account_id, role)`. A row with `path NULL` means None; no row means Automatic. The table and its migration live in `src/server/db/folder-mappings.ts` (schema version 481001) to keep `store.ts` edits to the account delete and three thin wrappers, which limits merge conflicts with parallel branches. `PUT` replaces the whole set because the sheet edits all roles together.
- **Provider wiring**: an optional `MailProvider.setFolderOverrides`. The service pushes the stored overrides when it registers an account's clients and after each `PUT`. This avoids changing the provider factory signature used by `index.ts` and tests.
- **Validation**: an override path must be a selectable folder currently listed for the account, must not be INBOX, and must not be used for two roles; otherwise 400.
- **`specialUseSource`** (`override`, `special-use`, `name`, or `null`) is optional on folders so Gmail and existing clients stay valid. The sheet uses it to show "found by name" so the owner can tell a guess from a server flag.

### Identities

- **Wildcards are rows in the existing `identities` table** with address `*@domain` (lower case). No schema change. `domain` must be a valid hostname with a dot; `*@*` and partial patterns are refused. Subdomains are not covered: `*@example.com` does not cover `a@mail.example.com`, so the owner declares each domain explicitly.
- **One shared resolver** `identityFor(address, account, identities)` returns the sender for an address: the primary, then an exact identity, then a wildcard on its domain. The server (`#draftSender`, signature checks) and web (From default, Send enablement, reply recipient exclusion) both use it. This is the "only declared domains" guard: `#draftSender` refuses anything it returns `null` for.
- **Reply default From** keeps the order Delivered-To, To, Cc. The first candidate that resolves wins, and the exact candidate address is used, not the wildcard pattern. Sender name comes from the identity (wildcard name).
- **Signatures** may be stored for a wildcard identity (`*@example.com`). For a sending address the client picks the exact signature, then the wildcard's. No signature per individual covered address; the owner can add the exact address as an identity for that.
- **Gmail refuses wildcards** (400): Gmail only sends from verified Send mail as addresses and would reject every covered address before dispatch, so accepting the pattern would only produce failures later.
- **Own-address checks in correspondents** (recipient suggestions) also understand wildcards, so mail sent from a covered address counts as sent mail and covered addresses are not suggested as recipients. Its triggers are recreated once (detected from the stored trigger SQL) and the table rebuilt.
- **Add as identity from compose**: shown when the source's Delivered-To contains an address that does not resolve. It posts the exact address with the account name, updates the identities query cache in place, and switches From to it. Only Delivered-To is offered, because To/Cc often name other people.
- **Gmail Send mail as import** is additive and idempotent: it adds every verified (primary flag or verification not `pending`) non-primary address, named by its Gmail display name or the account name, and leaves existing identities and their names alone. It never removes identities: removal would also delete signatures the owner wrote, and a stale alias is caught at send time by the existing Send-as check. Connecting a Gmail account runs it once, best effort; a failure there does not fail the connection.

## Risks / Trade-offs

- [Heuristic picks a wrong folder, e.g. a shared "Archive"] → owner sets the role in Manage folders; `specialUseSource` shows that it was a guess.
- [Name-detected folders become protected] → documented in the sheet footer; set the role to None to rename.
- [Wildcard lets a typo in the domain allow unintended From addresses] → still limited to what the owner typed and what their SMTP server accepts.

## Migration Plan

Schema version 481001 creates `folder_mappings`. Existing accounts start with no overrides, so behavior only changes where the name heuristic now finds folders that were missing. Rollback: the table is ignored by older code.
