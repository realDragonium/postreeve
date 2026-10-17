import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/server/api";
import { Store } from "../src/server/db/store";
import { createTestHarness } from "./support/test-mail";
import type { ProviderMessageSummary } from "../src/server/mail/provider";
import { SORT_KEYS_MIGRATION, SOURCE_COUNTS_MIGRATION } from "../src/server/sync/query";
import type { MailboxQueryInput } from "../src/shared/mailbox-query";

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const tenant = "test-tenant";

function message(accountId: string, uid: number, extra: Partial<ProviderMessageSummary> = {}): ProviderMessageSummary {
  return { ref: { accountId, mailbox: "INBOX", uidValidity: "1", uid, modseq: "1" },
    messageId: `<${accountId}-${uid}@query.test>`, subject: `Subject ${uid}`,
    from: [{ name: `Sender ${uid}`, address: `sender${uid}@query.test` }],
    to: [{ name: "Recipient", address: "recipient@query.test" }], receivedAt: new Date(Date.UTC(2026, 0, 1, 0, uid)).toISOString(),
    preview: "Preview", searchBody: "Body", searchHeaders: "Content-Type: text/plain", read: true, flagged: false, ...extra };
}
async function fixture(path = ":memory:") {
  const store = new Store(path); close.push(() => store.close());
  for (const accountId of ["a", "b"]) {
    await store.insertAccount({ id: accountId, kind: "imap", name: accountId === "a" ? "Personal" : "Work", email: `${accountId}@query.test`, encryptedCredentials: null });
    store.synchronization.schedule(tenant, accountId, 0);
  }
  return store;
}
function index(store: Store, accountId: string, messages: ProviderMessageSummary[], now = 1000) {
  store.synchronization.observe({ tenantId: tenant, accountId, provider: "imap" }, messages, now);
}
function all(store: Store, input: MailboxQueryInput, candidateLimit?: number, between?: (page: number) => void) {
  const seen = [];
  let page = store.synchronization.query(tenant, input, [], candidateLimit);
  seen.push(...page.messages);
  for (let count = 1; page.nextCursor; count++) {
    between?.(count);
    page = store.synchronization.query(tenant, { ...input, cursor: page.nextCursor }, [], candidateLimit);
    seen.push(...page.messages);
  }
  return seen;
}
const subjects = (store: Store, input: MailboxQueryInput) => store.synchronization.query(tenant, input).messages.map(item => item.subject).sort();
const inbox = (accountId: string) => ({ accountId, mailbox: "INBOX" });
/** Recomputes the per-mailbox counters from scratch. */
function recount(store: Store) {
  return store.synchronization.sqlite.query(`SELECT l.tenant_id,l.account_id,l.mailbox,COUNT(i.rowid) total,
      COALESCE(SUM(json_type(i.content,'$.searchBody')='text'),0) bodies FROM message_locations l
    LEFT JOIN indexed_messages i ON i.tenant_id=l.tenant_id AND i.account_id=l.account_id AND i.message_id=l.message_id
    GROUP BY 1,2,3 ORDER BY 1,2,3`).all();
}
function counters(store: Store) {
  return store.synchronization.sqlite.query(`SELECT tenant_id,account_id,mailbox,total,bodies FROM indexed_source_counts
    WHERE total<>0 OR bodies<>0 ORDER BY 1,2,3`).all();
}

describe("search operators", () => {
  async function corpus() {
    const store = await fixture();
    index(store, "a", [
      message("a", 1, { subject: "Invoice March", from: [{ name: "Alex Doe", address: "alex@vendor.test" }], read: false }),
      message("a", 2, { subject: "Board meeting notes", cc: [{ name: "Kim", address: "kim@query.test" }], flagged: true,
        searchHeaders: "Content-Type: multipart/mixed; boundary=x", searchBody: "please review the attached minutes" }),
      message("a", 3, { subject: "Newsletter", receivedAt: "2025-06-01T00:00:00.000Z", searchBody: "weekly digest from the vendor" }),
      message("a", 4, { subject: "Re: invoice", ref: { ...message("a", 4).ref, mailbox: "Sent" },
        to: [{ name: "Alex Doe", address: "alex@vendor.test" }], from: [{ name: "Me", address: "a@query.test" }] }),
    ]);
    index(store, "b", [message("b", 1, { subject: "Contract draft", ref: { ...message("b", 1).ref, mailbox: "Archive" }, searchBody: "the contract terms" }),
      message("b", 2, { subject: "Team lunch" })]);
    return store;
  }
  const sources = [inbox("a"), { accountId: "a", mailbox: "Sent" }, inbox("b")];

  test("field operators match only their field", async () => {
    const store = await corpus();
    expect(subjects(store, { sources, query: "from:alex" })).toEqual(["Invoice March"]);
    expect(subjects(store, { sources, query: "to:alex" })).toEqual(["Re: invoice"]);
    expect(subjects(store, { sources, query: "cc:kim" })).toEqual(["Board meeting notes"]);
    expect(subjects(store, { sources, query: "cc:recipient" })).toEqual([]);
    expect(subjects(store, { sources, query: "subject:invoice" })).toEqual(["Invoice March", "Re: invoice"]);
    expect(subjects(store, { sources, query: "subject:review" })).toEqual([]);
  });

  test("phrases are literal, words combine with AND, negation excludes", async () => {
    const store = await corpus();
    expect(subjects(store, { sources, query: `"attached minutes"` })).toEqual(["Board meeting notes"]);
    expect(subjects(store, { sources, query: `"minutes attached"` })).toEqual([]);
    expect(subjects(store, { sources, query: "minutes attached" })).toEqual(["Board meeting notes"]);
    expect(subjects(store, { sources, query: "invoice -subject:re:" })).toEqual(["Invoice March"]);
    expect(subjects(store, { sources, query: "invoice -from:alex" })).toEqual(["Re: invoice"]);
    expect(subjects(store, { sources, query: "-invoice -lunch" })).toEqual(["Board meeting notes", "Newsletter"]);
  });

  test("state, attachment and date operators", async () => {
    const store = await corpus();
    expect(subjects(store, { sources, query: "is:unread" })).toEqual(["Invoice March"]);
    expect(subjects(store, { sources, query: "is:flagged" })).toEqual(["Board meeting notes"]);
    expect(subjects(store, { sources, query: "has:attachment" })).toEqual(["Board meeting notes"]);
    expect(subjects(store, { sources, query: "before:2026-01-01" })).toEqual(["Newsletter"]);
    expect(subjects(store, { sources, query: "after:2026-01-01 -has:attachment is:read" })).toEqual(["Re: invoice", "Team lunch"]);
    expect(store.synchronization.query(tenant, { sources, query: "before:2026-13-01" }).messages).toEqual([]);
  });

  test("in: and account: narrow the sources", async () => {
    const store = await corpus();
    expect(subjects(store, { sources, query: "in:sent" })).toEqual(["Re: invoice"]);
    expect(subjects(store, { sources, query: "invoice -in:sent" })).toEqual(["Invoice March"]);
    expect(subjects(store, { sources, query: "account:b@query.test" })).toEqual(["Team lunch"]);
    expect(subjects(store, { sources, query: "account:work" })).toEqual(["Team lunch"]);
    expect(subjects(store, { sources, query: "in:archive" })).toEqual([]);
  });

  test("everywhere scope and in:anywhere search every folder of every account", async () => {
    const store = await corpus();
    expect(subjects(store, { scope: "everywhere", query: "contract" })).toEqual(["Contract draft"]);
    expect(subjects(store, { sources: [inbox("a")], query: "contract in:anywhere" })).toEqual(["Contract draft"]);
    expect(subjects(store, { scope: "everywhere", query: "in:archive" })).toEqual(["Contract draft"]);
    expect(store.synchronization.query(tenant, { scope: "everywhere" }).messages).toHaveLength(6);
    expect(store.synchronization.allSources(tenant)).toEqual([
      { accountId: "a", mailbox: "INBOX" }, { accountId: "a", mailbox: "Sent" }, { accountId: "b", mailbox: "Archive" }, { accountId: "b", mailbox: "INBOX" }]);
  });

  test("short terms that the trigram index cannot narrow still match literally", async () => {
    const store = await corpus();
    expect(subjects(store, { sources, query: "re" })).toContain("Re: invoice");
    expect(subjects(store, { sources, query: "from:me" })).toEqual(["Re: invoice"]);
  });
});

describe("keyset pagination", () => {
  for (const [plan, candidateLimit] of [["sorted candidates", 100_000], ["sort index walk", 0]] as const) {
    test(`${plan}: ties page exactly once and inserts between pages do not shift positions`, async () => {
      for (const sort of ["newest", "oldest", "sender", "subject"] as const) {
        const store = await fixture();
        // Thirty messages share one timestamp, sender and subject, so only canonical identity breaks the tie.
        index(store, "a", Array.from({ length: 30 }, (_, i) => message("a", i + 1, { receivedAt: "2026-01-01T00:00:00.000Z",
          subject: "Same", from: [{ name: "Same", address: "same@query.test" }] })));
        index(store, "b", Array.from({ length: 25 }, (_, i) => message("b", i + 1)));
        const input: MailboxQueryInput = { sources: [inbox("a"), inbox("b")], sort, limit: 7 };
        let uid = 100;
        const seen = all(store, input, candidateLimit, () => {
          // A message that sorts first and one that sorts last arrive between every pair of pages.
          index(store, "a", [message("a", uid++, { receivedAt: "2030-01-01T00:00:00.000Z", subject: "AAA", from: [{ name: "AAA", address: "x@query.test" }] }),
            message("a", uid++, { receivedAt: "2020-01-01T00:00:00.000Z", subject: "zzz", from: [{ name: "zzz", address: "z@query.test" }] })], 2000);
        });
        const ids = seen.map(item => item.canonicalId);
        expect(new Set(ids).size).toBe(ids.length);
        const original = seen.filter(item => item.ref.uid < 100);
        expect(original).toHaveLength(55);
      }
    });
  }

  test("both plans return the same order", async () => {
    const store = await fixture();
    index(store, "a", Array.from({ length: 40 }, (_, i) => message("a", i + 1, { read: i % 3 === 0, receivedAt: new Date(Date.UTC(2026, 0, 1, 0, i % 5)).toISOString() })));
    for (const input of [{ sources: [inbox("a")], limit: 6 }, { sources: [inbox("a")], filter: "unread" as const, limit: 4, sort: "sender" as const },
      { sources: [inbox("a")], query: "subject 1", limit: 3 }]) {
      expect(all(store, input, 0).map(item => item.canonicalId)).toEqual(all(store, input, 100_000).map(item => item.canonicalId));
    }
  });
});

describe("conversation grouping", () => {
  async function threads() {
    const store = await fixture();
    const root = message("a", 1, { subject: "Plan", from: [{ name: "Alice", address: "alice@query.test" }] });
    index(store, "a", [root,
      message("a", 2, { subject: "Re: Plan", inReplyTo: root.messageId, references: [root.messageId], from: [{ name: "Bob", address: "bob@query.test" }], read: false, preview: "Bob reply" }),
      message("a", 3, { subject: "Re: Plan", inReplyTo: root.messageId, references: [root.messageId], from: [{ name: "Alice", address: "alice@query.test" }], preview: "Alice again" }),
      message("a", 4, { subject: "Lunch" }),
      message("a", 5, { subject: "Re: Plan", inReplyTo: root.messageId, references: [root.messageId], ref: { ...message("a", 5).ref, mailbox: "Archive" } }),
    ]);
    return { store, root };
  }

  test("one row per conversation with count, unread, participants and latest snippet in the view", async () => {
    const { store } = await threads();
    const page = store.synchronization.query(tenant, { sources: [inbox("a")], group: "conversation" });
    expect(page.messages.map(item => item.subject)).toEqual(["Lunch", "Re: Plan"]);
    const plan = page.groups![1]!;
    expect(plan).toMatchObject({ count: 3, unread: 1, latest: { preview: "Alice again" } });
    expect(plan.participants.map(participant => participant.name)).toEqual(["Alice", "Bob"]);
    expect(plan.members.map(member => member.ref.uid)).toEqual([3, 2, 1]);
    expect(page.groups![0]).toMatchObject({ count: 1, unread: 0 });
    // The filter applies to the group too: only the unread reply is in the Unread view.
    const unread = store.synchronization.query(tenant, { sources: [inbox("a")], group: "conversation", filter: "unread" });
    expect(unread.groups?.map(group => group.count)).toEqual([1]);
    const archived = store.synchronization.query(tenant, { sources: [inbox("a"), { accountId: "a", mailbox: "Archive" }], group: "conversation" });
    expect(archived.groups?.find(group => group.count > 1)?.count).toBe(4);
  });

  test("groups page once each and a new reply between pages does not repeat its conversation", async () => {
    for (const candidateLimit of [0, 100_000]) {
      const { store, root } = await threads();
      index(store, "a", Array.from({ length: 6 }, (_, i) => message("a", 10 + i, { subject: `Solo ${i}` })));
      const input: MailboxQueryInput = { sources: [inbox("a")], group: "conversation", limit: 2 };
      const seen = all(store, input, candidateLimit, page => {
        if (page === 1) index(store, "a", [message("a", 50, { subject: "Re: Plan", inReplyTo: root.messageId, references: [root.messageId],
          receivedAt: "2030-01-01T00:00:00.000Z" })], 2000);
      });
      const conversations = seen.map(item => item.conversationId);
      expect(new Set(conversations).size).toBe(conversations.length);
      expect(conversations.length).toBeGreaterThanOrEqual(7);
    }
  });
});

describe("indexed counters and sort keys", () => {
  test("per-mailbox counters follow indexing, moves, retention, removals and account deletion", async () => {
    const store = await fixture();
    const sync = store.synchronization;
    index(store, "a", Array.from({ length: 12 }, (_, i) => message("a", i + 1, { searchBody: i % 2 ? null : "Body" })));
    index(store, "b", [message("b", 1), { ...message("b", 2), messageId: message("a", 1).messageId }]);
    expect(counters(store)).toEqual(recount(store));
    sync.confirmedAction({ tenantId: tenant, accountId: "a", provider: "imap" }, message("a", 1).ref,
      { ...message("a", 1).ref, mailbox: "Archive", uid: 900 });
    expect(counters(store)).toEqual(recount(store));
    sync.configureRetention({ maxAgeDays: 1, maxContentBytes: 10 });
    sync.enforceRetention(tenant, "a", 1000 + 2 * 86_400_000);
    expect(counters(store)).toEqual(recount(store));
    sync.sqlite.query("DELETE FROM message_locations WHERE tenant_id=? AND account_id='a' AND uid IN (2,3)").run(tenant);
    expect(counters(store)).toEqual(recount(store));
    await store.deleteAccount("b");
    expect(counters(store)).toEqual(recount(store));
    expect(sync.coverage(tenant, [inbox("a")]).sources[0]).toMatchObject({ indexedMessages: 9, bodiesAvailable: 0 });
  });

  test("the migration backfills sort keys and counters from an earlier index and keeps the first copy's anchor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postreeve-query-migration-"));
    const path = join(directory, "index.sqlite");
    try {
      let store = await fixture(path);
      index(store, "a", [message("a", 1, { subject: "Middle" }), message("a", 2, { subject: "Zulu", searchBody: null }), message("a", 3, { subject: "Alpha" })]);
      // A later copy of message 1 in account b must not move its anchor.
      index(store, "b", [{ ...message("b", 9, { subject: "AAA later copy" }), messageId: message("a", 1).messageId }], 2000);
      const expected = { counts: counters(store), order: subjects(store, { sources: [inbox("a"), inbox("b")], sort: "subject" }) };
      store.synchronization.sqlite.exec(`DROP TABLE indexed_sort_keys; DROP TABLE indexed_source_counts;
        DROP TRIGGER indexed_sort_keys_insert; DROP TRIGGER indexed_sort_keys_update; DROP TRIGGER indexed_sort_keys_delete;
        DELETE FROM schema_migrations WHERE version IN (${SORT_KEYS_MIGRATION},${SOURCE_COUNTS_MIGRATION});`);
      for (const trigger of store.synchronization.sqlite.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'indexed_source_counts_%'").all() as Array<{ name: string }>) {
        store.synchronization.sqlite.exec(`DROP TRIGGER ${trigger.name}`);
      }
      store.close();
      store = new Store(path);
      close.push(() => store.close());
      expect(counters(store)).toEqual(expected.counts);
      expect(counters(store)).toEqual(recount(store));
      const ordered = store.synchronization.query(tenant, { sources: [inbox("a"), inbox("b")], sort: "subject" }).messages;
      expect(ordered.map(item => item.messageId)).toEqual([message("a", 3).messageId, message("a", 1).messageId, message("a", 2).messageId]);
      expect(subjects(store, { sources: [inbox("a"), inbox("b")], sort: "subject" })).toEqual(expected.order);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("query API", () => {
  test("everywhere reads the index without provider fallback; scoped search sends providers the free text only", async () => {
    const harness = await createTestHarness(); close.push(() => harness.store.close());
    const { service, account, store } = harness;
    const provider = harness.providerForAccount(account.id)!;
    const searched: string[] = [];
    provider.searchMessages = async (_accountId, _mailbox, query) => { searched.push(query); return []; };
    store.synchronization.observe({ tenantId: tenant, accountId: account.id, provider: "imap" },
      [message(account.id, 1, { subject: "Contract", ref: { ...message(account.id, 1).ref, mailbox: "Archive" }, searchBody: null })], Date.now());
    const api = createApi(service);
    const post = (body: unknown) => api.request("/api/messages/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ sources: [], query: "contract" })).status).toBe(400);
    for (const body of [{ scope: "everywhere", query: "contract" }, { sources: [inbox(account.id)], query: "contract in:anywhere in:archive" }]) {
      const response = await post(body);
      expect(response.status).toBe(200);
      const page = await response.json() as { messages: Array<{ subject: string }>; coverage: { sources: Array<{ mailbox: string; fallback: string }> } };
      expect(page.messages.map(item => item.subject)).toEqual(["Contract"]);
      expect(page.coverage.sources.some(source => source.mailbox === "Archive")).toBe(true);
    }
    expect(searched).toEqual([]);
    await service.queryMessages({ sources: [{ accountId: account.id, mailbox: "Archive" }], query: "contract from:alex -draft" });
    expect(searched).toEqual(["contract"]);
  });
});
