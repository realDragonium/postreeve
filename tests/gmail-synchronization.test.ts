import { describe, expect, test } from "bun:test";
import { Store } from "../src/server/db/store";
import { MailProviderRegistry } from "../src/server/mail/provider";
import { SynchronizationRunner } from "../src/server/sync/runner";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
import { SynchronizationError, syncPageSchema, type SyncPage } from "../src/server/mail/synchronization";

const account = { id: "gmail", name: "Gmail", email: "person@example.test", kind: "gmail" as const };
const scope = { tenantId: "tenant", accountId: account.id, provider: "gmail" as const };
const json = (body: unknown, status = 200) => Response.json(body, { status });
function metadata(id: string, labelIds = ["INBOX", "UNREAD"], messageId = `<${id}@example.test>`) {
  return { id, threadId: "thread", historyId: "120", labelIds, internalDate: "1720000000000",
    snippet: `Preview ${id}`, payload: { headers: [{ name: "Message-ID", value: messageId }, { name: "Subject", value: id }] } };
}
function fixture(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const request: HttpFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture", expires_in: 3600 });
    return handler(url, init);
  };
  const client = new GmailMailClient({ account, credentials: { kind: "gmail", refreshToken: "fixture" }, clientId: "fixture", fetch: request });
  return { client, calls };
}
function page(client: GmailMailClient, cursor: string | null, limit = 100, signal = new AbortController().signal) {
  return client.synchronization.fetchPage({ account: scope, scope: { kind: "account" }, cursor, limit, signal });
}
async function finish(client: GmailMailClient, initial: string | null = null, limit = 100) {
  const pages: SyncPage[] = [];
  let cursor = initial;
  for (let i = 0; i < 100; i++) {
    const next = await page(client, cursor, limit);
    syncPageSchema.parse(next);
    expect(next.messages.length).toBeLessThanOrEqual(limit);
    expect(next.snapshots?.flatMap(snapshot => snapshot.seen).length ?? 0).toBeLessThanOrEqual(limit);
    pages.push(next); cursor = next.cursor;
    if (!next.hasMore) return { pages, cursor };
  }
  throw new Error("Synchronization did not finish");
}

describe("Gmail synchronization", () => {
  test("bootstraps all message pages, catches changes made during listing and resumes from the committed history", async () => {
    let incremental = false;
    const { client, calls } = fixture(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("includeSpamTrash")).toBe("true");
        return url.searchParams.has("pageToken") ? json({ messages: [{ id: "b" }] })
          : json({ messages: [{ id: "a" }], nextPageToken: "second" });
      }
      if (url.pathname.endsWith("/history")) {
        if (incremental) {
          expect(url.searchParams.get("startHistoryId")).toBe("120");
          return json({ historyId: "130", history: [{ id: "121", labelsAdded: [{ message: { id: "a" } }] }] });
        }
        expect(url.searchParams.get("startHistoryId")).toBe("100");
        return json({ historyId: "120", history: [{ id: "110", messagesAdded: [{ message: { id: "c" } }] }] });
      }
      const id = url.pathname.split("/").at(-1)!;
      return json(metadata(id, incremental ? ["Label_project", "STARRED"] : ["INBOX", "UNREAD"]));
    });
    expect(await client.synchronization.discoverScopes(scope, new AbortController().signal)).toEqual([{ kind: "account" }]);
    const initial = await finish(client);
    expect(initial.pages[0]).toMatchObject({ messages: [], coverage: "catching-up", snapshots: [{ phase: "start", seen: [] }] });
    expect(initial.pages.at(-1)?.snapshots?.[0]?.phase).toBe("complete");
    expect(new Set(initial.pages.flatMap(value => value.messages.map(message => message.ref.providerId)))).toEqual(new Set(["a", "b", "c"]));
    incremental = true;
    const changes = await finish(client, initial.cursor);
    expect(changes.pages.at(-1)).toMatchObject({ coverage: "complete", locationSets: [{ providerId: "a", mailboxes: ["Label_project", "__archive__"] }] });
    expect(changes.pages.flatMap(value => value.messages).every(message => message.flagged && message.read)).toBe(true);
    expect(calls.filter(url => url.pathname.endsWith("/profile"))).toHaveLength(1);
  });

  test("deduplicates history events, pages many IDs within one record and confirms deletion", async () => {
    let phase = "bootstrap";
    const { client } = fixture(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) return json({});
      if (url.pathname.endsWith("/history")) {
        if (phase === "bootstrap") return json({ historyId: "100" });
        if (url.searchParams.has("pageToken")) return json({ historyId: "999999999999999999", history: [{ id: "103", messagesDeleted: [{ message: { id: "gone" } }] }] });
        return json({ historyId: "999999999999999999", nextPageToken: "last", history: [{ id: "101", messages: [{ id: "a" }],
          messagesAdded: [{ message: { id: "b" } }, { message: { id: "a" } }], labelsRemoved: [{ message: { id: "a" } }] }] });
      }
      const id = url.pathname.split("/").at(-1)!;
      return id === "gone" ? json({ error: "missing" }, 404) : json(metadata(id));
    });
    const initial = await finish(client); phase = "changes";
    const result = await finish(client, initial.cursor, 1);
    expect(result.pages.filter(value => value.locationSets?.[0]?.providerId === "a")).toHaveLength(1);
    expect(result.pages.at(-1)?.locationSets).toEqual([{ providerId: "gone", mailboxes: [] }]);
    expect(JSON.parse(result.cursor!).historyId).toBe("999999999999999999");
    expect(result.pages.slice(0, -1).every(value => value.hasMore)).toBe(true);
  });

  test("repairs expired history and malformed cursors without claiming early completion", async () => {
    let expired = false;
    const { client } = fixture(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: expired ? "200" : "100" });
      if (url.pathname.endsWith("/messages")) return json({});
      if (url.pathname.endsWith("/history")) return expired && url.searchParams.get("startHistoryId") === "100"
        ? json({ error: "expired" }, 404) : json({ historyId: expired ? "200" : "100" });
      throw new Error(`Unexpected request ${url}`);
    });
    const initial = await finish(client); expired = true;
    const repair = await page(client, initial.cursor);
    expect(repair).toMatchObject({ hasMore: true, coverage: "catching-up", snapshots: [{ phase: "start" }] });
    expect(repair.snapshots?.[0]?.generation).not.toBe(initial.pages[0]?.snapshots?.[0]?.generation);
    expect((await finish(client, repair.cursor)).pages.at(-1)?.snapshots?.[0]?.phase).toBe("complete");
    expect((await page(client, "broken")).coverage).toBe("catching-up");
  });

  test("pins the message during label fanout even when the first listing page changes", async () => {
    let listed = 0;
    const { client } = fixture(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) { listed++; return json({ messages: [{ id: listed === 1 ? "a" : "new" }] }); }
      if (url.pathname.endsWith("/history")) return json({ historyId: "100" });
      const id = url.pathname.split("/").at(-1)!;
      return json(metadata(id, ["Label_a", "Label_b", "Label_c"]));
    });
    const result = await finish(client, null, 1);
    expect(listed).toBe(1);
    expect(result.pages.flatMap(value => value.messages).map(message => message.ref.mailbox)).toEqual(["Label_a", "Label_b", "Label_c", "__archive__"]);
    expect(result.pages.filter(value => value.locationSets?.length)).toHaveLength(1);
  });

  test("does not turn malformed metadata or transient failures into confirmed deletion", async () => {
    let failure = "malformed";
    const { client } = fixture(url => {
      if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "a" }] });
      return failure === "malformed" ? json({ id: "a", payload: {} }) : json({ error: "try again" }, 503);
    });
    const started = await page(client, null);
    await expect(page(client, started.cursor)).rejects.toThrow();
    failure = "transient";
    await expect(page(client, started.cursor)).rejects.toThrow("try again");
  });

  test("passes cancellation to transport and classifies invalid grants without leaking provider messages", async () => {
    const controller = new AbortController();
    const { client } = fixture((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return json({ historyId: "100" });
    });
    await expect(page(client, null, 100, controller.signal)).rejects.toThrow();
    const unauthorized = new GmailMailClient({ account, credentials: { kind: "gmail", refreshToken: "fixture" }, clientId: "fixture",
      fetch: async () => json({ error: "invalid_grant", error_description: "sensitive-provider-message" }, 400) });
    const result = page(unauthorized, null);
    await expect(result).rejects.toBeInstanceOf(SynchronizationError);
    await expect(result).rejects.toThrow("Synchronization failed: reauthorization");
    await expect(client.synchronization.fetchPage({ account: { ...scope, accountId: "other" }, scope: { kind: "account" }, cursor: null,
      limit: 1, signal: new AbortController().signal })).rejects.toThrow("invalid-data");
  });
});

test("Gmail adapter through durable runner preserves identity across repair, restart and tenant isolation", async () => {
  let repairing = false;
  const { client } = fixture(url => {
    if (url.pathname.endsWith("/profile")) return json({ historyId: repairing ? "200" : "100" });
    if (url.pathname.endsWith("/messages")) return repairing ? json({ messages: [{ id: "a" }] })
      : url.searchParams.has("pageToken") ? json({ messages: [{ id: "b" }] })
      : json({ messages: [{ id: "a" }], nextPageToken: "b-page" });
    if (url.pathname.endsWith("/history")) {
      if (!repairing) return json({ historyId: "120" });
      if (url.searchParams.get("startHistoryId") === "120") return json({ error: "expired" }, 404);
      return json({ historyId: "220", history: [{ id: "210", messagesAdded: [{ message: { id: "c" } }] }] });
    }
    const id = url.pathname.split("/").at(-1)!;
    return json(metadata(id, repairing ? ["Label_retained", "STARRED"] : ["INBOX", "UNREAD"], id === "a" ? "" : `<${id}@example.test>`));
  });
  const store = new Store(":memory:");
  try {
    await store.insertAccount({ ...account, encryptedCredentials: null });
    const registry = new MailProviderRegistry(); registry.register(account.id, client);
    let now = 0;
    const runnerFor = (tenant = scope.tenantId) => new SynchronizationRunner(store.synchronization, tenant, registry,
      { now: () => now, pollMs: 100, pageLimit: 1 });
    const drain = async (runner: SynchronizationRunner) => {
      for (let count = 0; count < 100; count++) { if (!await runner.runOnce()) return; }
      throw new Error("Runner did not become idle");
    };
    const runner = runnerFor(); runner.schedule(account.id); await drain(runner);
    const original = store.synchronization.indexed(scope.tenantId, account.id, "INBOX");
    expect(original).toHaveLength(2);
    const originalA = original.find(message => message.ref.providerId === "a")!;
    expect(original.every(message => message.conversationId === originalA.conversationId)).toBe(true);
    const other = runnerFor("other-tenant"); other.schedule(account.id); await drain(other);
    repairing = true; now = 100;
    await runner.runOnce();
    expect(store.synchronization.jobs(scope.tenantId)[0]?.coverage).toBe("catching-up");
    expect(store.synchronization.indexed(scope.tenantId, account.id, "INBOX")).toHaveLength(2);
    await runner.runOnce();
    await runner.runOnce();
    expect(store.synchronization.indexed(scope.tenantId, account.id, "INBOX").map(message => message.ref.providerId)).toEqual(["b"]);
    // A replacement runner resumes the SQL cursor and snapshot evidence.
    await drain(runnerFor());
    expect(store.synchronization.jobs(scope.tenantId)[0]?.coverage).toBe("complete");
    expect(store.synchronization.indexed(scope.tenantId, account.id, "INBOX")).toEqual([]);
    const repaired = store.synchronization.indexed(scope.tenantId, account.id, "Label_retained");
    expect(repaired).toHaveLength(2);
    expect(repaired.find(message => message.ref.providerId === "a")).toMatchObject({ canonicalId: originalA.canonicalId,
      conversationId: originalA.conversationId, flagged: true, read: true });
    expect(repaired.find(message => message.ref.providerId === "c")?.conversationId).toBe(originalA.conversationId);
    expect(await store.getMessage(scope.tenantId, originalA.canonicalId)).not.toBeNull();
    expect(store.synchronization.indexed("other-tenant", account.id, "INBOX")).toHaveLength(2);
  } finally { store.close(); }
});

test("malformed synchronization metadata preserves indexed content, flags, locations and history", async () => {
  let response: unknown = metadata("a", ["INBOX", "UNREAD", "STARRED"]);
  let changing = false;
  const { client } = fixture(url => {
    if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "a" }] });
    if (url.pathname.endsWith("/history")) return changing
      ? json({ historyId: "130", history: [{ id: "125", labelsRemoved: [{ message: { id: "a" } }] }] })
      : json({ historyId: "120" });
    return json(response);
  });
  const store = new Store(":memory:");
  try {
    await store.insertAccount({ ...account, encryptedCredentials: null });
    const registry = new MailProviderRegistry(); registry.register(account.id, client);
    let now = 0;
    const runner = new SynchronizationRunner(store.synchronization, scope.tenantId, registry, { now: () => now, pollMs: 100 });
    runner.schedule(account.id);
    for (let i = 0; i < 3; i++) await runner.runOnce();
    const before = store.synchronization.indexed(scope.tenantId, account.id, "INBOX");
    expect(before).toHaveLength(1);
    const checkpoint = store.synchronization.scopes(scope)[0]!.cursor;
    changing = true; now = 100;
    const full = metadata("a", []);
    const malformed: unknown[] = [
      { id: "a", labelIds: [], payload: {} },
      { ...full, payload: {} },
      { ...full, historyId: undefined },
      { ...full, threadId: undefined },
      { ...full, internalDate: undefined },
      { ...full, internalDate: "invalid" },
    ];
    for (response of malformed) {
      runner.retry(account.id);
      await runner.runOnce();
      expect(store.synchronization.jobs(scope.tenantId)[0]).toMatchObject({ state: "retry", error: "invalid-data" });
      expect(store.synchronization.scopes(scope)[0]?.cursor).toBe(checkpoint);
      expect(store.synchronization.indexed(scope.tenantId, account.id, "INBOX")).toEqual(before);
      expect(store.synchronization.indexed(scope.tenantId, account.id, "__archive__")).toEqual([]);
    }
    // Empty RFC headers and an empty label set are valid when the transport metadata is complete.
    response = { ...full, payload: { headers: [] } };
    runner.retry(account.id); await runner.runOnce();
    expect(store.synchronization.jobs(scope.tenantId)[0]).toMatchObject({ coverage: "complete", error: null });
    expect(store.synchronization.indexed(scope.tenantId, account.id, "__archive__")[0]?.canonicalId).toBe(before[0]?.canonicalId);
  } finally { store.close(); }
});

for (const rejection of [400, 404]) {
  test(`repeated repair rejection ${rejection} reaches durable failure instead of restarting indefinitely`, async () => {
    let profiles = 0;
    let reject = true;
    const { client } = fixture(url => {
      if (url.pathname.endsWith("/profile")) { profiles++; return json({ historyId: "100" }); }
      if (url.pathname.endsWith("/messages")) {
        if (rejection === 400 && reject) return url.searchParams.has("pageToken")
          ? json({ error: "invalid page token" }, 400) : json({ nextPageToken: "expired" });
        return json({});
      }
      return reject ? json({ error: "history expired" }, 404) : json({ historyId: "200" });
    });
    const store = new Store(":memory:");
    try {
      await store.insertAccount({ ...account, encryptedCredentials: null });
      const registry = new MailProviderRegistry(); registry.register(account.id, client);
      let now = 0;
      const createRunner = () => new SynchronizationRunner(store.synchronization, scope.tenantId, registry, { now: () => now, pollMs: 100 });
      let runner = createRunner(); runner.schedule(account.id);
      let iterations = 0;
      while (iterations++ < 20 && await runner.runOnce()) {}
      expect(iterations).toBeLessThan(20);
      expect(profiles).toBe(4);
      expect(store.synchronization.jobs(scope.tenantId)[0]).toMatchObject({ state: "retry", error: "provider", coverage: "catching-up" });
      const checkpoint = store.synchronization.scopes(scope)[0]!.cursor;
      runner = createRunner(); now = 100;
      await runner.runOnce();
      expect(profiles).toBe(4);
      expect(store.synchronization.scopes(scope)[0]?.cursor).toBe(checkpoint);
      reject = false;
      runner.retry(account.id);
      for (let i = 0; i < 3; i++) await runner.runOnce();
      expect(store.synchronization.jobs(scope.tenantId)[0]).toMatchObject({ error: null, coverage: "complete" });
      expect(JSON.parse(store.synchronization.scopes(scope)[0]!.cursor!).repairRestarts).toBe(0);
    } finally { store.close(); }
  });
}

test("resumes a multi-message history record after interrupted label fanout while newer history arrives", async () => {
  let changing = false;
  let recordReads = 0;
  const handler = (url: URL) => {
    if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
    if (url.pathname.endsWith("/messages")) return json({});
    if (url.pathname.endsWith("/history")) {
      expect(url.searchParams.get("maxResults")).toBe("1");
      if (!changing) return json({ historyId: "100" });
      if (url.searchParams.has("pageToken")) return json({ historyId: "160", history: [{ id: "151", messagesAdded: [{ message: { id: "c" } }] }] });
      recordReads++;
      return json({ historyId: recordReads > 1 ? "160" : "150", nextPageToken: "newer",
        history: [{ id: "101", labelsAdded: [{ message: { id: "b" } }, { message: { id: "a" } }] }] });
    }
    const id = url.pathname.split("/").at(-1)!;
    return json(metadata(id, id === "a" ? ["Label_a", "Label_b"] : ["INBOX"]));
  };
  const firstClient = fixture(handler).client;
  const initial = await finish(firstClient);
  changing = true;
  const first = await page(firstClient, initial.cursor, 1);
  expect(first.messages[0]?.ref).toMatchObject({ providerId: "a", mailbox: "Label_a" });
  const resumed = await finish(fixture(handler).client, first.cursor, 1);
  const all = [first, ...resumed.pages];
  expect(all.flatMap(value => value.messages).map(message => `${message.ref.providerId}/${message.ref.mailbox}`)).toEqual([
    "a/Label_a", "a/Label_b", "a/__archive__", "b/INBOX", "c/INBOX",
  ]);
  expect(all.flatMap(value => value.locationSets ?? []).map(set => set.providerId)).toEqual(["a", "b", "c"]);
  expect(recordReads).toBe(2);
  expect(JSON.parse(resumed.cursor!).historyId).toBe("160");
});

test("bounds serialized pages when a large summary fans out to many Gmail labels", async () => {
  const labels = Array.from({ length: 100 }, (_, index) => `Label_${String(index).padStart(3, "0")}`);
  const subject = "s".repeat(30_000);
  const { client } = fixture(url => {
    if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "a" }] });
    if (url.pathname.endsWith("/history")) return json({ historyId: "120" });
    return json({ ...metadata("a", labels), payload: { headers: [{ name: "Subject", value: subject }] } });
  });
  const result = await finish(client);
  expect(result.pages.filter(value => value.messages.length > 0).length).toBeGreaterThan(1);
  for (const value of result.pages) expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.pages.flatMap(value => value.messages).map(message => message.ref.mailbox)).toEqual([...labels, "__archive__"]);
  expect(result.pages.flatMap(value => value.locationSets ?? [])).toEqual([{ providerId: "a", mailboxes: [...labels, "__archive__"] }]);
  expect(result.pages.flatMap(value => value.messages).every(message => message.subject === subject)).toBe(true);
});

test("rejects a single summary that expands beyond the page bound without trimming identity headers", async () => {
  const references = Array.from({ length: 45_000 }, (_, index) => `<reference-${index}@example.test>`).join(" ");
  const { client } = fixture(url => {
    if (url.pathname.endsWith("/profile")) return json({ historyId: "100" });
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "a" }] });
    return json({ ...metadata("a"), payload: { headers: [{ name: "References", value: references }] } });
  });
  const started = await page(client, null);
  await expect(page(client, started.cursor)).rejects.toThrow("Synchronization failed: invalid-data");
});
