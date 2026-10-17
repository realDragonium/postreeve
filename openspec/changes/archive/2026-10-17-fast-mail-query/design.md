# Design

## Context

`indexed_messages` holds one JSON summary per tenant/account/canonical message. `message_locations` holds one row per provider location, with read and flag state. `indexed_search` is a trigram FTS5 table keyed by `indexed_messages.rowid`. Sort anchors (`sortReceivedAt`, `sortSender`, `sortSubject`) live inside the JSON. The anchor of a canonical message is the one in its first indexed row by rowid, so a later duplicate in another account cannot move it between pages.

The previous `queryIndex` built a CTE over every location in the selected sources. For each one it found the anchor row with a correlated subquery, ran `ROW_NUMBER()` per message, sorted everything by `json_extract`, and only then applied `LIMIT`. Search checked `instr()` on six FTS columns for every FTS row before the MATCH clause narrowed anything. Two further costs sat outside `queryIndex`. `Store.#getMessage` looked up each summary with `message.id = ? OR alias.alias_id = ?` across a LEFT JOIN, which scans `messages`: about 7 ms per row at 100k, or 350 ms per page. Coverage ran `COUNT(DISTINCT …)` with `json_type(content)` for every location before every page: 300 ms for a 60k-location unified Inbox.

## Goals / Non-Goals

**Goals:** pages under about 50 ms at 100k summaries for list, unified list, search and grouped views; search operators shared by the UI and agents; a search across all mail; a grouped list; a justified retention default.

**Non-goals:**
- Gmail's full query language (`OR`, parentheses, `larger:`, `label:` as distinct from `in:`, relative dates).
- Exact attachment detection from MIME structure.
- Server-side grouping for WebMCP tools.
- Provider fallback for the everywhere scope.

## Decisions

1. **Sort keys move to an indexed table, not to columns on `indexed_messages`.** Anchors are per canonical message, while `indexed_messages` has one row per account. A `WITHOUT ROWID` table `indexed_sort_keys(tenant_id, message_id, received_at, sender, subject)` has three indexes `(tenant_id, key, message_id)`, one per sort order, and keeps exactly one key per message. Triggers on `indexed_messages` maintain it:
   - Insert is `INSERT OR IGNORE`, so the first row wins, as the rowid anchor did.
   - An update of the anchor row's content refreshes the key.
   - A delete re-derives the key from the lowest remaining rowid.

   The canonical-merge upsert in `db/store.ts` keeps working unchanged: it inserts the retained message's rows (first wins) and deletes the removed message's rows, which drops their key. Migration 490001 backfills keys in rowid order. Adding the keys as columns on `message_locations` was rejected: locations are written before their indexed row exists, so keeping them in step would need cross-table triggers in both directions.

2. **Each page chooses its plan from capped counts.** A page has two possible candidate sets:
   - full-text matches, when there is a positive term of three or more characters (trigram minimum) and no provider fallback ids;
   - locations in the selected sources, counted through the `(tenant, account, provider, mailbox, …)` unique index and filtered by read/flag state.

   Each count stops at `CANDIDATE_SORT_LIMIT + 1` (4,000). If the smaller set fits, the page joins it to the sort keys, applies the full predicate, sorts it and limits it. Otherwise the page walks the sort index with `INDEXED BY` and checks the predicate per message until it has `limit + 1` messages. A large candidate set means dense matches, so the walk stops early. A small set is cheap to sort. Either way a page reads about N/10 rows at worst. The one case without a good driver is a very selective term shorter than three characters inside a large view. It degrades to a scan, which is acceptable for such rare queries.

   The sources are kept as the outermost loop with `CROSS JOIN`. Without it SQLite scanned every location of the tenant (110 ms) instead of seeking each mailbox (12 ms).

3. **The predicate is evaluated per location.** A message is in the view if it has a location in the sources whose state matches the filter and `is:` operators, and whose own account's indexed row and FTS row match the text operators. The previous query had the same semantics: search and flags applied to the joined location and its account's row. Text checks use `instr()` on the lowercased FTS columns read by rowid, so matching stays literal, with punctuation intact. FTS only narrows candidates. `cc:` checks the `cc` array in the summary JSON, because the FTS `recipients` column mixes To, Cc, Reply-To and delivery addresses. `to:` uses that column, which also matches Cc, as Gmail does. Date operators compare the canonical first-indexed received time stored in the sort key.

4. **Representatives are chosen after the page is fixed.** The same `ROW_NUMBER()` ordering as before (account, mailbox, uid desc, …) now runs only over the at most 51 chosen messages.

5. **Search operators are parsed in the shared module.** `parseMailboxQuery` returns terms (`any|from|to|cc|subject`, value, negated), tri-state `unread`, `flagged` and `attachment`, the `after`/`before` UTC day bounds, the `in:`/`account:` filters, `anywhere`, and errors.
   - A token that starts with a quote is literal, so `"from:alex"` searches that text. Unknown `name:value` stays literal, so `re:` and URLs work as before.
   - An invalid date returns no results instead of silently widening the search.
   - `in:` matches a full path, the last path segment, or a special-use alias table (`sent` matches `SENT`, `Sent Items`, `[Gmail]/Sent Mail` and `INBOX.Sent`), because special-use metadata lives with the provider, not in SQLite.
   - `account:` matches an id, or part of an address or name.
   - `in:` and `account:` resolve to a narrowed source list before the query runs.
   - `has:attachment` means the retained headers declare `multipart/mixed`. This works on both providers and for rows indexed before this change, without a provider change. It misses attachments inside `multipart/related`, and it counts an empty `multipart/mixed`.

6. **Provider fallback gets the free text only.** IMAP and Gmail cannot interpret Postreeve operators the same way, so fallback searches the positive free-text terms. Fallback ids bypass only the free-text condition: operators, filters and dates still apply to them. An operator-only query falls back to provider listing for unsynchronized sources.

7. **The everywhere scope reads the index only.** `scope: "everywhere"` or `in:anywhere` resolves to every account/mailbox with indexed messages, read from the counters table. Provider fallback is skipped, because ten calls of five seconds across dozens of folders would make the scope slow. Coverage still reports each folder's synchronization and body availability. `sources` may be empty only with this scope. WebMCP schemas stay unchanged: agents get the scope through `in:anywhere` in the same query string, which avoids touching the `feat/remote-mcp` files beyond one description.

8. **Coverage reads per-folder counters.** `indexed_source_counts(tenant, account, mailbox, total, bodies)` counts locations that have an indexed row and, of those, the ones with body text. Triggers on both tables apply deltas against the current state of the other table, so the invariant holds after every row change, including merges, moves, retention and account deletion (cascades fire triggers). Migration 490002 backfills it, and a test compares it with a recount after each kind of change.

   `indexedMessages` now counts indexed locations rather than distinct canonical messages. The two differ only for duplicate copies inside one mailbox. The per-message trigger had to force `INDEXED BY message_locations_message_id_idx`: with `GROUP BY` SQLite chose the `(tenant, account, id)` index, and seeding became quadratic.

9. **Grouping is server-side, by keyset on the conversation's first message.** With `group: "conversation"` a message is kept only if no other message of its conversation in the view sorts before it, a `NOT EXISTS` over `conversation_messages`. The page's keyset is that representative's key, so a conversation appears once across pages. A reply that arrives later sorts after an already shown representative, or before the cursor, and does not repeat the conversation. Each group carries:
   - `count` and `unread` over all its members in the view;
   - up to 10 distinct first senders, newest first, as `participants`;
   - the newest member's time and preview as `latest`;
   - up to 100 member summaries.

   The UI expands a selected group into its members in `targetsFor`, so Archive, Spam, Move, read and flag actions reach every message of the conversation in the current view and no others. Agents keep individual messages, each with its `conversationId`.

10. **The canonical lookup uses two indexed queries.** Id first, then alias. This alone removes about 350 ms per 100k page.

11. **Migrations stay in code.** The repository versions migrations in `schema_migrations` from TypeScript and has no Drizzle migration folder, so there is no Drizzle journal to collide with. Sort keys and counters each have their own function (`migrateSortKeys`, `migrateSourceCounts`) and version (490001, 490002). Both are additive, idempotent, and rebuildable by deleting their `schema_migrations` row.

## Retention decision

The benchmark seeded 20k summaries with 0, 400 and 1,600 body words (about 0, 2.8 and 11 KB each). The database grew from 60 MiB to 318 MiB and then 946 MiB, which is 4–5 bytes on disk per retained body byte: the summary JSON copy, the FTS content copy and the trigram index. Real text has more distinct trigrams, so use 5×.

Age therefore does not bound disk; the byte budget does. With the old defaults, a 100 MiB budget could still reach about 500 MiB per account, while 30 days gave search only a month of bodies. A typical account (about 30 messages a day at about 3 KB of body text) retains about 36 MiB of text per year.

- **Default age: 365 days.** Body search covers a year, which is what a daily driver needs, and most accounts stay under the budget.
- **Default budget: 64 MiB per account**, about 320 MiB of disk at the cap. Two heavy accounts fit in about 640 MiB, which leaves room for metadata and WAL on a 1 GB volume. Lighter accounts never reach the cap. Operators with several heavy accounts on a small volume lower `POSTREEVE_CONTENT_RETENTION_BYTES`. README documents the 5× factor.
- Lowering the budget evicts the oldest retained text on upgrade. The text is disposable cache; provider mail and metadata are untouched, and provider fallback still finds older bodies in account and folder views.

## Benchmark

`bun scripts/bench-mail-query.ts 100000 20` seeds 100k summaries: 3 accounts, Inbox 60%, Archive 30%, Sent 7%, Junk 3%, a third of messages replying to a recent message, 10% unread, 2% flagged and about 280-character bodies. It then times `SynchronizationStore.query`, measured in the container this change was built in.

| Case | Before p50/p95 ms | After p50/p95 ms |
| --- | --- | --- |
| List Inbox, newest, page 1 / 5 | 1628 / 1814, 1578 / 1702 | 2.7 / 13.6, 2.5 / 6.5 |
| List Inbox, sender | 614 / 625 | 4.3 / 8.2 |
| List Inbox, unread | 1227 / 1367 | 35.8 / 41.5 |
| List Sent (small folder) | 1382 / 1514 | 13.5 / 18.6 |
| Unified Inbox, newest | 2045 / 2154 | 2.0 / 3.1 |
| Unified Inbox, subject | 801 / 865 | 2.7 / 4.4 |
| Search Inbox, common word | 1836 / 2056 | 4.6 / 6.3 |
| Search unified, rare address | 1223 / 1259 | 12.1 / 15.2 |
| Search unified, phrase | 1563 / 1652 | 7.1 / 9.8 |
| Search with operators | not supported | 30.7 / 46.2 |
| Search everywhere | not supported | 4.3 / 5.8 |
| Grouped Inbox | not supported | 6.2 / 8.4 |
| Grouped unified, subject | not supported | 8.8 / 11.1 |
| Coverage, unified Inbox (runs before every API page) | 297 / 401 | 0.0 / 0.6 |


Seeding 100k rows took 45 s before and 48 s after, so the extra triggers cost little on write.

## Risks / Trade-offs

- Triggers now maintain three derived tables. A trigger bug would drift silently. The counter test recounts after each kind of change, and both tables can be rebuilt by deleting their migration rows.
- `has:attachment` is a header heuristic, documented as such.
- `indexedMessages` counts indexed locations, not distinct messages.
- The UI groups conversations; WebMCP does not. Agents can group by `conversationId`. When **Conversations** is on, a view that an agent opens shows the same query grouped. Opening a view from an agent turns **Everywhere** off, so the page lists what the agent received.
- Cursors issued before this change are rejected once, because the cursor scope now includes the scope and grouping. The UI restarts paging.
