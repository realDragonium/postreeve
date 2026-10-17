# Tasks

## 1. Benchmark and baseline

- [x] 1.1 Add `scripts/bench-mail-query.ts` (synthetic 100k summaries in a temporary SQLite file; p50/p95 for list, unified, search, grouped and coverage)
- [x] 1.2 Record the baseline on the earlier implementation

## 2. Index and query planning

- [x] 2.1 `indexed_sort_keys` with per-sort indexes, maintenance triggers and the 490001 backfill
- [x] 2.2 `indexed_source_counts` with location/indexed-row triggers and the 490002 backfill; coverage and everywhere sources read it
- [x] 2.3 Rewrite `queryIndex`: capped candidate counts, sorted candidates or sort-index walk, per-location predicate, representatives after paging
- [x] 2.4 Split the canonical id/alias lookup into two indexed queries
- [x] 2.5 Tests: keyset stability with ties and inserts between pages on both plans, both plans agree, counter invariant after each kind of change, migration backfill keeps anchors

## 3. Search operators and scope

- [x] 3.1 Shared `parseMailboxQuery`, `plainSearchText`, `folderMatches`, `accountMatches`; schema `scope`, `group` and optional sources
- [x] 3.2 Apply operators in the query; resolve `in:`/`account:`/`in:anywhere` to sources; provider fallback searches free text only; everywhere skips fallback
- [x] 3.3 Parser and operator tests; WebMCP `search_messages` description lists the operators

## 4. Conversation grouping

- [x] 4.1 `group: "conversation"` keyset on the first message per conversation, group details and members
- [x] 4.2 Web: Conversations and Everywhere toggles, grouped rows, group expansion for actions; unit and e2e tests

## 5. Retention, docs and verification

- [x] 5.1 Measure disk per retained byte; defaults 365 days and 64 MiB per account
- [x] 5.2 Update README and FEATURES.md
- [x] 5.3 `bun run verify`, `bunx openspec validate --specs --strict`, e2e and the 100k benchmark
