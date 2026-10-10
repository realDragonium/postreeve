import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Store } from "../src/server/db/store";
import { createApi } from "../src/server/api";
import { mailboxPageSchema, type MailboxQueryInput } from "../src/shared/mailbox-query";
import type { ProviderMessageSummary } from "../src/server/mail/provider";
import { createTestHarness } from "./support/test-mail";
import { migrateSearchIndex } from "../src/server/sync/query";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const tenant = "test-tenant";
function message(accountId: string, uid: number, extra: Partial<ProviderMessageSummary> = {}): ProviderMessageSummary {
  return { ref: { accountId, mailbox: "INBOX", uidValidity: "1", uid, modseq: "1" },
    messageId: `<${uid}@search.test>`, subject: `Subject ${String(uid).padStart(3,"0")}`,
    from: [{ name: `Sender ${String(uid).padStart(3,"0")}`, address: "sender@search.test" }],
    to: [{ name: "Recipient", address: "recipient@search.test" }], receivedAt: new Date(Date.UTC(2026,0,1,0,0,Math.floor(uid / 3))).toISOString(),
    preview: "Preview text", searchBody: "Body text", searchHeaders: "X-Tracking: tracking-number", read: uid % 2 === 0, flagged: uid % 3 === 0, ...extra };
}
async function fixture() {
  const store = new Store(":memory:"); close.push(() => store.close());
  for (const accountId of ["a","b"]) {
    await store.insertAccount({ id: accountId, kind: "imap", name: accountId, email: `${accountId}@search.test`, encryptedCredentials: null });
    store.synchronization.schedule(tenant,accountId,0);
  }
  return store;
}
function index(store: Store, accountId: string, messages: ProviderMessageSummary[]) {
  const sync = store.synchronization;
  sync.observe({ tenantId: tenant,accountId,provider: "imap" },messages,1000);
}

describe("indexed mailbox search", () => {
  test("pages all synchronized mail with ties and stable positions when new mail arrives, for every sort", async () => {
    for (const sort of ["newest","oldest","sender","subject"] as const) {
      const store = await fixture();
      index(store,"a",Array.from({ length: 237 },(_, i) => message("a",i+1)));
      const input: MailboxQueryInput = { sources: [{accountId:"a",mailbox:"INBOX"}],sort,limit:40 };
      const all = [];
      let page = store.synchronization.query(tenant,input);
      all.push(...page.messages);
      const added = message("a",900,{ receivedAt: sort === "oldest" ? "2020-01-01T00:00:00.000Z" : "2030-01-01T00:00:00.000Z",subject:"AAAA",from:[{name:"AAAA",address:"new@search.test"}] });
      index(store,"a",[added]);
      while (page.nextCursor) { page = store.synchronization.query(tenant,{...input,cursor:page.nextCursor}); all.push(...page.messages); }
      expect(all).toHaveLength(237);
      expect(new Set(all.map(m => m.canonicalId)).size).toBe(237);
    }
  });

  test("new duplicate locations cannot move existing canonical sort anchors across pages", async () => {
    for (const sort of ["newest", "oldest", "sender", "subject"] as const) {
      for (const duplicateAccount of ["a", "b"]) {
        const store = await fixture();
        index(store, "b", Array.from({ length: 120 }, (_, i) => message("b", i + 1)));
        const input = { sources: [{ accountId: "a", mailbox: "INBOX" }, { accountId: "b", mailbox: "INBOX" }], sort, limit: 50 };
        let page = store.synchronization.query(tenant, input);
        const seen = [...page.messages];
        const uid = sort === "newest" ? 30 : 90;
        index(store, duplicateAccount, [{ ...message(duplicateAccount, uid),
          ref: { ...message(duplicateAccount, 999).ref },
          receivedAt: sort === "newest" ? "2030-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
          subject: "AAAA duplicate", from: [{ name: "AAAA duplicate", address: "duplicate@test.local" }] }]);
        while (page.nextCursor) {
          page = store.synchronization.query(tenant, { ...input, cursor: page.nextCursor });
          seen.push(...page.messages);
        }
        expect(seen).toHaveLength(120);
        expect(new Set(seen.map(item => item.canonicalId)).size).toBe(120);
        expect(seen.some(item => item.messageId === `<${uid}@search.test>`)).toBe(true);
      }
    }
  });

  test("canonical merges preserve the retained message's sort anchor", async () => {
    const store = await fixture();
    index(store, "a", [message("a", 1, { messageId: "", subject: "Zulu", searchBody: null }), message("a", 2, { subject: "Mike", searchBody: "Retained canonical body" }),
      message("a", 3, { subject: "Alpha" }), message("a", 4, { subject: "Yankee" })]);
    const input = { sources: [{ accountId: "a", mailbox: "INBOX" }], sort: "subject" as const };
    const retained = store.synchronization.query(tenant, input).messages.find(item => item.messageId === "<2@search.test>")!;
    store.synchronization.observe({ tenantId: tenant, accountId: "a", provider: "imap" },
      [message("a", 1, { messageId: "", subject: "Zulu", searchBody: null })], 1500);
    store.synchronization.observe({ tenantId: tenant, accountId: "a", provider: "imap" },
      [message("a", 1, { messageId: "<2@search.test>", subject: "ZZZ latest copy", searchBody: null })], 2000);
    const ordered = store.synchronization.query(tenant, input).messages;
    expect(ordered).toHaveLength(3);
    expect(ordered[1]?.canonicalId).toBe(retained.canonicalId);
    expect(ordered[1]?.subject).toBe("ZZZ latest copy");
    expect(store.synchronization.query(tenant, { ...input, query: "Retained canonical body" }).messages).toHaveLength(1);
  });

  test.each(["retained", "removed"])("canonical merges keep the newest body observation from the %s record without renewing its age", async newest => {
    const store = await fixture();
    const sync = store.synchronization;
    const scope = { tenantId: tenant, accountId: "a", provider: "imap" as const };
    const retained = message("a", 2, { searchBody: "Retained body" });
    const removed = message("a", 1, { messageId: "", searchBody: "Removed body" });
    sync.observe(scope, [retained, removed], 1000);
    sync.observe(scope, [newest === "retained" ? retained : removed], 1200);
    sync.observe(scope, [{ ...(newest === "retained" ? removed : retained), searchBody: null }], 1500);
    sync.observe(scope, [{ ...removed, messageId: retained.messageId, searchBody: null }], 2000);
    const input = { sources: [{ accountId: "a", mailbox: "INBOX" }], query: `${newest} body` };
    expect(sync.query(tenant, input).messages).toHaveLength(1);
    sync.configureRetention({ maxAgeDays: 1, maxContentBytes: 100000 });
    sync.enforceRetention(tenant, "a", 1200 + 86_400_000);
    expect(sync.query(tenant, input).messages).toHaveLength(0);
    sync.observe(scope, [{ ...removed, messageId: retained.messageId, searchBody: null }], 1500 + 86_400_000);
    expect(sync.query(tenant, input).messages).toHaveLength(0);
  });

  test("backfills sort anchors and FTS from an earlier index and preserves them after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postreeve-search-migration-"));
    const path = join(directory, "index.sqlite");
    let store = new Store(path);
    try {
      await store.insertAccount({ id: "a", kind: "imap", name: "a", email: "a@search.test", encryptedCredentials: null });
      store.synchronization.schedule(tenant, "a", 0);
      index(store, "a", [message("a", 1, { subject: "Middle" }), message("a", 2, { subject: "Zulu" })]);
      const db = store.synchronization.sqlite;
      db.exec(`DROP TRIGGER indexed_search_insert; DROP TRIGGER indexed_search_update; DROP TRIGGER indexed_search_delete;
        DROP TABLE indexed_search; DELETE FROM schema_migrations WHERE version=487001;
        UPDATE indexed_messages SET content=json_remove(content,'$.sortReceivedAt','$.sortSender','$.sortSubject');`);
      migrateSearchIndex(db);
      const input = { sources: [{ accountId: "a", mailbox: "INBOX" }], sort: "subject" as const };
      expect(store.synchronization.query(tenant, { ...input, query: "Middle" }).messages).toHaveLength(1);
      store.close();
      store = new Store(path);
      index(store, "a", [{ ...message("a", 1, { subject: "ZZZ duplicate" }), ref: message("a", 999).ref }]);
      expect(store.synchronization.query(tenant, input).messages.map(item => item.messageId)).toEqual(["<1@search.test>", "<2@search.test>"]);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("searches precise fields literally, filters before limiting and deduplicates across accounts", async () => {
    const store = await fixture();
    index(store,"a",Array.from({length:150},(_,i)=>message("a",i+1)));
    index(store,"b",[message("b",1),message("b",999,{ subject:"100%_literal",searchBody:"Special body only" })]);
    const input = {sources:[{accountId:"a",mailbox:"INBOX"},{accountId:"b",mailbox:"INBOX"}],limit:100};
    for (const query of ["sender@search","recipient@search","subject","tracking-number","preview","body text"]) {
      expect(store.synchronization.query(tenant,{...input,query}).messages).toHaveLength(100);
    }
    expect(store.synchronization.query(tenant,{...input,query:"100%_literal"}).messages).toHaveLength(1);
    expect(store.synchronization.query(tenant,{...input,query:"special body only"}).messages[0]?.ref.accountId).toBe("b");
    expect(store.synchronization.query(tenant,{...input,filter:"unread"}).messages).toHaveLength(76);
    expect(store.synchronization.query("other",input).messages).toEqual([]);
    const page=store.synchronization.query(tenant,{...input,limit:100});
    expect(store.synchronization.query(tenant,{...input,cursor:page.nextCursor!}).messages).toHaveLength(51);
  });

  test("rejects malformed and scope/query/filter/sort/tenant mismatched cursors", async () => {
    const store=await fixture();index(store,"a",[message("a",1),message("a",2)]);
    const input={sources:[{accountId:"a",mailbox:"INBOX"}],limit:1};
    const cursor=store.synchronization.query(tenant,input).nextCursor!;
    for(const extra of [{query:"changed"},{sort:"oldest" as const},{filter:"unread" as const},{sources:[{accountId:"b",mailbox:"INBOX"}]}]) {
      expect(()=>store.synchronization.query(tenant,{...input,...extra,cursor})).toThrow("cursor");
    }
    expect(()=>store.synchronization.query("foreign",{...input,cursor})).toThrow("cursor");
    expect(()=>store.synchronization.query(tenant,{...input,cursor:"malformed"})).toThrow("cursor");
  });

  test("evicts preview and body together, preserves metadata, and updates search and byte accounting", async () => {
    const store=await fixture();index(store,"a",[message("a",1)]);
    const sync=store.synchronization;const input={sources:[{accountId:"a",mailbox:"INBOX"}]};
    expect(sync.retainedContentBytes(tenant,"a")).toBe(Buffer.byteLength("Preview textBody text"));
    expect(sync.coverage(tenant,input.sources).sources[0]?.bodiesAvailable).toBe(1);
    sync.configureRetention({maxAgeDays:1,maxContentBytes:1});sync.enforceRetention(tenant,"a",1001);
    expect(sync.query(tenant,{...input,query:"body text"}).messages).toEqual([]);
    expect(sync.query(tenant,{...input,query:"preview"}).messages).toEqual([]);
    expect(sync.query(tenant,{...input,query:"tracking-number"}).messages).toHaveLength(1);
    expect(sync.coverage(tenant,input.sources).sources[0]?.bodiesAvailable).toBe(0);
    expect(sync.retainedContentBytes(tenant,"a")).toBe(0);
  });

  test("metadata refresh does not extend the age of retained body text", async () => {
    const store=await fixture();const sync=store.synchronization;
    index(store,"a",[message("a",1)]);
    sync.configureRetention({maxAgeDays:1,maxContentBytes:100000});
    const {searchBody:_body,...metadata}=message("a",1);
    sync.observe({tenantId:tenant,accountId:"a",provider:"imap"},[metadata],1000+86_400_000);
    expect(sync.query(tenant,{sources:[{accountId:"a",mailbox:"INBOX"}],query:"body text"}).messages).toEqual([]);
    expect(sync.query(tenant,{sources:[{accountId:"a",mailbox:"INBOX"}],query:"preview"}).messages).toHaveLength(1);
  });

  test("API pages backend unified results, keeps provider-only matches and cached results when fallback fails", async () => {
    const harness=await createTestHarness();close.push(()=>harness.store.close());
    const {service,account,store}=harness;
    const query={sources:[{accountId:account.id,mailbox:"INBOX"}],query:"needle",limit:1};
    const provider=harness.providerForAccount(account.id)!;
    let calls=0;
    provider.searchMessages=async()=>{calls++;return [message(account.id,500,{searchBody:null,preview:"",subject:"Remote match"}),message(account.id,501,{searchBody:null,preview:"",subject:"Other remote match"})];};
    const api=createApi(service);
    const response=await api.request("/api/messages/query",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(query)});
    expect(response.status).toBe(200);
    const first=mailboxPageSchema.parse(await response.json());expect(first.messages).toHaveLength(1);expect(first.nextCursor).not.toBeNull();
    expect(first.coverage.sources[0]?.fallback).toBe("limited");
    const second=await service.queryMessages({...query,cursor:first.nextCursor!});expect(second.messages).toHaveLength(1);expect(calls).toBe(1);
    expect(second.messages[0]?.canonicalId).not.toBe(first.messages[0]?.canonicalId);
    store.synchronization.observe({tenantId:tenant,accountId:account.id,provider:"imap"},[message(account.id,700,{searchBody:"Needle cached",subject:"Cached match"})],Date.now());
    provider.searchMessages=async()=>{throw new Error("offline");};
    const failed=await service.queryMessages(query);expect(failed.messages[0]?.subject).toBe("Cached match");expect(failed.coverage.sources[0]?.fallback).toBe("failed");
  });

  test("unavailable fallback bodies preserve cached matches and their original expiry", async () => {
    let now = 1000;
    const { service, store, account, providerForAccount } = await createTestHarness({ synchronization: { now: () => now } });
    close.push(() => store.close());
    const sync = store.synchronization;
    const cached = message(account.id, 700, { searchBody: "Needle cached", preview: "", subject: "Cached match" });
    sync.observe({ tenantId: tenant, accountId: account.id, provider: "imap" }, [cached], now);
    sync.configureRetention({ maxAgeDays: 1, maxContentBytes: 100000 });
    const provider = providerForAccount(account.id)!;
    provider.searchMessages = async () => [{ ...cached, searchBody: null }];
    const query = { sources: [{ accountId: account.id, mailbox: "INBOX" }], query: "needle" };
    now += 1000;
    expect((await service.queryMessages(query)).messages).toHaveLength(1);
    provider.searchMessages = async () => { throw new Error("offline"); };
    expect((await service.queryMessages(query)).messages).toHaveLength(1);
    now = 1000 + 86_400_000;
    expect((await service.queryMessages(query)).messages).toHaveLength(0);
  });

  test.each(["", "needle"])("bounds fallback waiting and ignores late results for query '%s'", async query => {
    const { service, store, account, providerForAccount } = await createTestHarness();
    close.push(() => store.close());
    store.synchronization.observe({ tenantId: tenant, accountId: account.id, provider: "imap" },
      [message(account.id, 700, { subject: "Needle cached" })], Date.now());
    const provider = providerForAccount(account.id)!;
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<ProviderMessageSummary[]>();
    provider.searchMessages = () => { started.resolve(); return result.promise; };
    provider.listMessagePage = () => { started.resolve(); return result.promise.then(messages => ({ messages, complete: false })); };
    const timer = spyOn(globalThis, "setTimeout");
    try {
      const pending = service.queryMessages({ sources: [{ accountId: account.id, mailbox: "INBOX" }, { accountId: account.id, mailbox: "Other" }], query });
      await started.promise;
      const expire = timer.mock.calls.find(call => call[1] === 5000)?.[0];
      if (typeof expire !== "function") throw new Error("Fallback deadline was not scheduled");
      expire();
      const page = await pending;
      expect(page.messages.some(item => item.subject === "Needle cached")).toBe(true);
      expect(page.coverage.sources.map(source => source.fallback)).toEqual(["failed", "not-requested"]);
      result.resolve([message(account.id, 999, { subject: "Needle late" })]);
      await result.promise;
      await Promise.resolve();
      expect(store.synchronization.query(tenant, { sources: [{ accountId: account.id, mailbox: "INBOX" }], query: "Needle late" }).messages).toHaveLength(0);
    } finally { timer.mockRestore(); }
  });

  test("caps total fallback calls across many incomplete sources", async () => {
    const { service, store, account, providerForAccount } = await createTestHarness();
    close.push(() => store.close());
    let calls = 0;
    providerForAccount(account.id)!.searchMessages = async () => { calls++; return []; };
    const page = await service.queryMessages({ query: "needle", sources: Array.from({ length: 1000 }, (_, index) => ({ accountId: account.id, mailbox: `Folder-${index}` })) });
    expect(calls).toBe(10);
    expect(page.coverage.sources.filter(source => source.fallback === "limited")).toHaveLength(10);
    expect(page.coverage.sources.filter(source => source.fallback === "not-requested")).toHaveLength(990);
  });

  test("confirmed actions and undo update indexed locations and flags without waiting for synchronization", async () => {
    const {service,store,account,messages}=await createTestHarness();close.push(()=>store.close());
    const sources=[{accountId:account.id,mailbox:"INBOX"}];
    const first=await service.queryMessages({sources});const target=first.messages.find(m=>!m.read)!;
    store.synchronization.observe({ tenantId: tenant, accountId: account.id, provider: "imap" },
      [{ ...target, ref: { ...target.ref, mailbox: "Other" } }], Date.now());
    const marked=await service.applyDirectActions({accountId:account.id,items:[{message:target.ref,subject:target.subject,action:{type:"mark_read"}}]});
    expect(store.synchronization.query(tenant,{sources}).messages.find(m=>m.canonicalId===target.canonicalId)?.read).toBe(true);
    expect(store.synchronization.query(tenant, { sources: [{ accountId: account.id, mailbox: "Other" }] }).messages[0]?.read).toBe(false);
    await service.undoBatch(marked.id);
    expect(store.synchronization.query(tenant,{sources}).messages.find(m=>m.canonicalId===target.canonicalId)?.read).toBe(false);
    const current=(await service.listMessages({accountId:account.id,mailbox:"INBOX",limit:50})).find(m=>m.ref.uid===messages[0]!.ref.uid)!;
    const moved=await service.applyDirectActions({accountId:account.id,items:[{message:current.ref,subject:current.subject,action:{type:"move",destination:"Archive"}}]});
    expect(store.synchronization.query(tenant,{sources}).messages.some(m=>m.canonicalId===current.canonicalId)).toBe(false);
    expect(store.synchronization.query(tenant,{sources:[{accountId:account.id,mailbox:"Archive"}]}).messages.some(m=>m.canonicalId===current.canonicalId)).toBe(true);
    await service.undoBatch(moved.id);
    expect(store.synchronization.query(tenant,{sources}).messages.some(m=>m.canonicalId===current.canonicalId)).toBe(true);
  });

  test("confirmed flag and undo update the flagged filter without waiting for synchronization", async () => {
    const {service,store,account}=await createTestHarness();close.push(()=>store.close());
    const sources=[{accountId:account.id,mailbox:"INBOX"}];
    const flagged=()=>service.queryMessages({sources,filter:"flagged"}).then(page=>page.messages.map(m=>m.canonicalId));
    const target=(await service.queryMessages({sources})).messages.find(m=>!m.flagged)!;
    const before=await flagged();
    const batch=await service.applyDirectActions({accountId:account.id,items:[{message:target.ref,subject:target.subject,action:{type:"flag"}}]});
    expect(batch.operations[0]?.status).toBe("applied");
    expect(await flagged()).toContain(target.canonicalId);
    expect((await service.queryMessages({sources})).messages.find(m=>m.canonicalId===target.canonicalId)?.read).toBe(target.read);
    await service.undoBatch(batch.id);
    expect(await flagged()).toEqual(before);
  });
});
