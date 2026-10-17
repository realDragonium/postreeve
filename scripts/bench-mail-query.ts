/**
 * Seeds synthetic indexed summaries into a temporary SQLite file and reports p50/p95 page latency for
 * list, unified list, search and grouped queries. Usage: bun scripts/bench-mail-query.ts [count] [runs]
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/db/store";
import { searchFields } from "../src/server/sync/query";
import type { MailboxQueryInput } from "../src/shared/mailbox-query";

const count = Number(process.argv[2] ?? 100_000);
const runs = Number(process.argv[3] ?? 30);
const bodyWords = Number(process.env.BENCH_BODY_WORDS ?? 40);
const tenant = "bench";
const accounts = ["acct-personal", "acct-work", "acct-side"];
const folders = [["INBOX", 0.6], ["Archive", 0.3], ["Sent", 0.07], ["Junk", 0.03]] as const;
const words = ["invoice", "meeting", "travel", "receipt", "quarterly", "planning", "release", "family", "newsletter", "order",
  "shipping", "contract", "review", "budget", "holiday", "update", "report", "photos", "dinner", "project"];
const people = Array.from({ length: 400 }, (_, i) => ({ name: `Person ${i}`, address: `person${i}@example${i % 25}.test` }));

let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
function folder(): string {
  let roll = random();
  for (const [name, share] of folders) { if ((roll -= share) <= 0) return name; }
  return "INBOX";
}

const directory = mkdtempSync(join(tmpdir(), "postreeve-bench-"));
const path = join(directory, "bench.sqlite");
try {
  const store = new Store(path);
  for (const id of accounts) {
    await store.insertAccount({ id, kind: "imap", name: id, email: `${id}@bench.test`, encryptedCredentials: null });
    store.synchronization.schedule(tenant, id, 0);
  }
  const started = performance.now();
  const start = Date.UTC(2020, 0, 1);
  const db = store.synchronization.sqlite;
  // Direct inserts mirror what reconciliation and indexing write; observe() per message is too slow for 100k rows.
  const insertMessage = db.query(`INSERT INTO messages(id,tenant_id,identity_key,message_id,in_reply_to,"references",received_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const insertConversation = db.query("INSERT INTO conversations(id,tenant_id,created_at,updated_at) VALUES(?,?,?,?)");
  const insertMember = db.query("INSERT INTO conversation_messages(tenant_id,conversation_id,message_id) VALUES(?,?,?)");
  const insertLocation = db.query(`INSERT INTO message_locations(id,message_id,tenant_id,account_id,provider,mailbox,location_key,uid_validity,uid,modseq,provider_id,read,flagged,observed_at)
    VALUES(?,?,?,?,'imap',?,?,'1',?,'1',NULL,?,?,?)`);
  const insertIndexed = db.query("INSERT INTO indexed_messages(tenant_id,account_id,message_id,received_at,content,updated_at) VALUES(?,?,?,?,?,?)");
  const uids = new Map<string, number>();
  const conversationOf: string[] = [];
  const now = new Date(start).toISOString();
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const account = accounts[i % accounts.length]!;
      const mailbox = folder();
      const key = `${account}\n${mailbox}`;
      const uid = (uids.get(key) ?? 0) + 1;
      uids.set(key, uid);
      // Every third message replies to a recent one, so conversations average a few messages.
      const parentIndex = i > 10 && i % 3 === 0 ? i - 1 - Math.floor(random() * 10) : null;
      const parent = parentIndex === null ? null : `<m${parentIndex}@bench.test>`;
      const id = `msg-${String(i).padStart(7, "0")}`;
      const conversation = parentIndex === null ? `conv-${i}` : conversationOf[parentIndex]!;
      conversationOf[i] = conversation;
      const topic = [pick(words), pick(words), pick(words)];
      const body = Array.from({ length: bodyWords }, () => pick(words)).join(" ");
      const summary = {
        messageId: `<m${i}@bench.test>`, inReplyTo: parent, references: parent ? [parent] : [],
        subject: `${parent ? "Re: " : ""}${topic.join(" ")} ${i}`,
        from: [pick(people)], to: [pick(people)], cc: random() < 0.2 ? [pick(people)] : [],
        receivedAt: new Date(start + i * 600_000 + Math.floor(random() * 300_000)).toISOString(),
        preview: body.slice(0, 200),
      };
      const searchable = searchFields(summary);
      const content = { ...summary, ...searchable, searchBody: body, searchBodyAt: start,
        searchHeaders: `message-id: <m${i}@bench.test>\ncontent-type: ${random() < 0.15 ? "multipart/mixed" : "text/plain"}; charset=utf-8`,
        sortReceivedAt: summary.receivedAt, sortSender: searchable.searchSenderSort, sortSubject: searchable.searchSubject };
      insertMessage.run(id, tenant, `message-id:${summary.messageId}`, summary.messageId, parent, JSON.stringify(summary.references), summary.receivedAt, now, now);
      if (parentIndex === null) insertConversation.run(conversation, tenant, now, now);
      insertMember.run(tenant, conversation, id);
      insertLocation.run(`loc-${i}`, id, tenant, account, mailbox, `1:${uid}`, uid, random() < 0.9 ? 1 : 0, random() < 0.02 ? 1 : 0, now);
      insertIndexed.run(tenant, account, id, summary.receivedAt, JSON.stringify(content), start);
    }
  })();
  store.synchronization.sqlite.exec("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);");
  console.log(`seeded ${count} summaries in ${((performance.now() - started) / 1000).toFixed(1)}s, database ${(statSync(path).size / 1048576).toFixed(1)} MiB`);

  const sync = store.synchronization;
  const inbox = (account: string) => ({ accountId: account, mailbox: "INBOX" });
  const cases: Array<[string, MailboxQueryInput]> = [
    ["list inbox newest", { sources: [inbox(accounts[0]!)] }],
    ["list inbox sender", { sources: [inbox(accounts[0]!)], sort: "sender" }],
    ["list inbox unread", { sources: [inbox(accounts[0]!)], filter: "unread" }],
    ["list small folder (Sent)", { sources: [{ accountId: accounts[0]!, mailbox: "Sent" }] }],
    ["unified inbox newest", { sources: accounts.map(inbox) }],
    ["unified inbox subject", { sources: accounts.map(inbox), sort: "subject" }],
    ["search inbox common (invoice)", { sources: [inbox(accounts[0]!)], query: "invoice" }],
    ["search unified rare (person7@)", { sources: accounts.map(inbox), query: "person7@" }],
    ["search unified phrase", { sources: accounts.map(inbox), query: "quarterly planning" }],
  ];
  // Cases the earlier implementation cannot run; set BENCH_BASELINE=1 to skip them.
  if (process.env.BENCH_BASELINE !== "1") {
    cases.push(
      ["search operators", { sources: accounts.map(inbox), query: "from:person1 is:unread -newsletter" }],
      ["search short term (re)", { sources: accounts.map(inbox), query: "re" }],
      ["search everywhere", { scope: "everywhere", query: "contract" }],
      ["search everywhere rare", { scope: "everywhere", query: "person7@ has:attachment" }],
      ["list everywhere newest", { scope: "everywhere" }],
      ["grouped inbox", { sources: [inbox(accounts[0]!)], group: "conversation" }],
      ["grouped unified subject", { sources: accounts.map(inbox), group: "conversation", sort: "subject" }],
    );
  }
  const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
  console.log("case | page | p50 ms | p95 ms | rows");
  for (const [name, input] of cases) {
    for (const page of [1, 5]) {
      let cursor: string | undefined;
      for (let p = 1; p < page; p++) cursor = sync.query(tenant, { ...input, ...(cursor ? { cursor } : {}) }).nextCursor ?? undefined;
      if (page > 1 && !cursor) continue;
      const times: number[] = [];
      let rows = 0;
      for (let run = 0; run < runs; run++) {
        const begin = performance.now();
        rows = sync.query(tenant, { ...input, ...(cursor ? { cursor } : {}) }).messages.length;
        times.push(performance.now() - begin);
      }
      console.log(`${name} | ${page} | ${percentile(times, 0.5).toFixed(1)} | ${percentile(times, 0.95).toFixed(1)} | ${rows}`);
    }
  }
  // Coverage runs before every page in the API; time it for the unified Inbox sources.
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const begin = performance.now();
    sync.coverage(tenant, accounts.map(inbox));
    times.push(performance.now() - begin);
  }
  console.log(`coverage unified inbox | - | ${percentile(times, 0.5).toFixed(1)} | ${percentile(times, 0.95).toFixed(1)} | -`);
  store.close();
} finally { if (process.env.BENCH_KEEP) console.log("kept", path); else rmSync(directory, { recursive: true, force: true }); }
