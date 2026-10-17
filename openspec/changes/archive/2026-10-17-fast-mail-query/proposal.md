# Proposal

No Linear issue: this is the `feat/mail-query` workstream of the daily-driver effort.

## Why

Postreeve should be a daily-use client for an owner with several accounts, and the message list and search are the hot path. At 100,000 indexed summaries a list page takes 1.6–2 s. Three things cause it. Every page runs a window function over every candidate in the selected folders. It sorts by `json_extract` through a correlated anchor subquery that has no supporting index. Search runs `instr()` over six full-text columns of every row before the trigram MATCH narrows anything. Each summary row also looks up its canonical message with an `OR` that scans the whole `messages` table, and coverage counts every location before each page.

Search is also weaker than people expect. It has no operators, cannot search all mail at once, and body text leaves the index after 30 days. The list cannot be grouped by conversation, although every message already carries a `conversationId`.

## What Changes

- **Indexed sort keys and planned pages.** A new `indexed_sort_keys` table holds each canonical message's first-indexed received time, sender and subject, with one index per sort order. Triggers keep it in step and a migration backfills it. A page picks the smaller of two candidate sets: full-text matches, or locations in the selected sources. It sorts that set when it is small. Otherwise it walks the sort index and stops after `limit + 1` matches. Keyset cursors are unchanged.
- **Per-folder counters.** A trigger-maintained `indexed_source_counts` table serves coverage in O(folders) instead of joining every location before each page.
- **Canonical lookup fix.** The alias lookup is split into two indexed queries.
- **Search operators.** `src/shared/mailbox-query.ts` gets a shared parser for `from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `is:unread`/`is:read`, `is:flagged`, `before:`, `after:`, `in:<folder>`, `account:<address>`, `in:anywhere`, quoted phrases and `-` negation. Unknown `name:value` words stay literal. The UI and WebMCP `search_messages` send the same query string, and provider fallback receives only the free text.
- **Everywhere scope.** `scope: "everywhere"` on `POST /api/messages/query`, or `in:anywhere`, searches every indexed folder of every account from the index only. The list header gets an **Everywhere** toggle while a search is active.
- **Conversation grouping.** `group: "conversation"` returns one row per conversation in the view. Each row has participants, a count, unread count, the latest snippet and up to 100 member summaries. The list header gets a **Conversations** toggle, persisted per browser. Actions on a group row apply to every member in the view.
- **Retention.** The default body/preview age goes from 30 to 365 days and the default per-account budget from 100 MiB to 64 MiB, because the byte budget, not the age, bounds disk use.
- `scripts/bench-mail-query.ts` seeds a temporary database and reports p50/p95 page latency.
- README and FEATURES.md are updated.

## Capabilities

### Modified Capabilities

- `mailbox/message-listing`: search operators, the everywhere scope, conversation grouping, the page latency budget, and cursor binding to scope and grouping.
- `mailbox/synchronization`: new retention defaults.
- `agents/webmcp-tools`: `search_messages` accepts the operator syntax, including `in:anywhere`.

## Impact

- `src/server/sync/query.ts`, `src/server/sync/store.ts`, `src/server/core/postreeve.ts`, `src/server/db/store.ts` (canonical lookup only).
- Two schema migrations, recorded as versions 490001 (sort keys) and 490002 (folder counters) in `schema_migrations`. They are additive and rebuildable from `indexed_messages` and `message_locations`.
- Shared contracts: `mailboxQuerySchema` gains `scope` and `group`, `sources` may be empty for the everywhere scope, and `mailboxPageSchema` gains optional `groups`.
- Web: `MessageList.tsx`, `mail-view.ts` and a small `App.tsx` change (query key, toggles, group expansion in `targetsFor`).
- WebMCP: description text of `search_messages` only.
