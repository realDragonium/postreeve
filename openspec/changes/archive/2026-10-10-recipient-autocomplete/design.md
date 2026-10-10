# Design

## Context

`indexed_messages` holds one row per (tenant, account, canonical message) with a JSON `content` column carrying `from`, `to` and `cc` (bounded to 100 addresses each). Synchronization writes it in `src/server/sync/store.ts`, which a parallel change is editing. Retention clears `preview` and `searchBody` by updating `content`; headers stay. Rows cascade-delete with their account. Own addresses are `accounts.email` plus the `identities` table.

## Goals / Non-Goals

**Goals:** per-keystroke lookups in milliseconds with ~10 accounts and hundreds of thousands of indexed messages; no edits to synchronization code; exact removal of an account's contribution.

**Non-Goals:** a contacts address book, editing or hiding suggestions, recipient chips, counting Bcc (the index does not hold it), Reply-To or co-recipients of received mail, provider contact APIs.

## Decisions

### A maintained `correspondents` table, kept by SQLite triggers

A query over `indexed_messages` would `json_each` every header of every message per keystroke: a full scan with JSON parsing, hundreds of milliseconds to seconds on large mailboxes. Instead `correspondents(tenant_id, account_id, address, name, name_at, sent_count, received_count, last_at)` keyed by `(tenant_id, account_id, address)` holds one row per distinct address per account, typically thousands, so a substring scan stays in the low milliseconds.

The table is maintained by `AFTER INSERT`, `AFTER DELETE` and `AFTER UPDATE OF content` triggers on `indexed_messages`. The update trigger has a `WHEN` clause comparing `from`, `to`, `cc` and `received_at`, so retention updates and re-observation of unchanged messages do not touch it. Triggers keep the module self-contained (precedent: the retained-content-bytes triggers) and avoid touching synchronization code. The alternative of maintaining it in `#index` was rejected to keep this change independent of the concurrent sync rework.

`account_id` references `accounts(id) ON DELETE CASCADE`, so removing an account removes its rows; the cascade-delete triggers on `indexed_messages` then find nothing to decrement.

Insert adds per message: if the first From address (lower case) is an own address, `sent_count + 1` for each distinct To/Cc address; otherwise `received_count + 1` for the first From address. Display name: an incoming non-empty name replaces the stored one when the stored one is empty or the message is at least as recent. Delete decrements with `MAX(0, …)` and removes rows where both counts reach zero.

On creation, the table is backfilled once from existing `indexed_messages` with the same insert logic.

### Ranking in SQL

Rows matching `instr(address, q) > 0 OR instr(lower(name), q) > 0` are grouped by address across accounts (excluding own addresses at query time, so a newly added identity disappears immediately). Order: prefix match on address or a name word start first, then `sent > 0`, then `(3 * sent + received) / (1 + age_days / 30)`, then address. `instr` avoids `LIKE` wildcard escaping.

### Compose fields stay text with a token-completion list

The draft model and validation work on comma-separated text (`parseRecipientList`, raw draft recipients). A `RecipientInput` component wraps the input with an ARIA combobox and listbox, completing only the token after the last comma. Converting to chips would change the draft field representation and paste/validation behavior for little gain now. Accepting inserts the bare address, because the send path already discards names from typed recipients.

Requests are debounced (150 ms) and cached through React Query keyed by the trimmed token; the token must be non-empty and contain no space-only content.

## Risks / Trade-offs

- [Classification uses own addresses at the time a message is indexed] → An identity added later does not reclassify already indexed mail from it until those rows are re-indexed; its own address is still excluded at query time. Documented; acceptable for ranking.
- [Delete-time classification can differ from insert-time] → Counts clamp at zero and rows with zero counts are removed; ranking is approximate by design.
- [`last_at` and the stored name are not rolled back when the newest message is removed] → Only affects ordering and the shown name until the address disappears entirely.
- [Triggers add work to every index write] → Measured at about 45 µs per inserted and 80 µs per deleted index row, against roughly 1 ms per message for the existing observe path; lookups over 8,000 correspondents took 6–8 ms.
- [SQLite `lower()` folds ASCII only] → Display names with non-ASCII capitals match only in their indexed case; addresses are lowercased by SQLite the same way. Acceptable for a typing aid.

## Migration Plan

The table, triggers and backfill are created idempotently on startup. Rollback: drop the triggers and table; no other data depends on them.
