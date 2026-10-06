import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/db/store";
import { MailProviderRegistry, toCanonicalObservation, type ProviderMessageSummary } from "../src/server/mail/provider";
import { SynchronizationError, type MailSynchronization, type SyncPage, type SyncScope } from "../src/server/mail/synchronization";
import { SynchronizationRunner } from "../src/server/sync/runner";
import type { SyncClaim } from "../src/server/sync/store";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

const tenant = "test-tenant";
const mailbox: SyncScope = { kind: "mailbox", mailbox: "INBOX" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function message(accountId = "account", uid = 1, overrides: Partial<ProviderMessageSummary> = {}): ProviderMessageSummary {
  return { ref: { accountId, mailbox: "INBOX", uidValidity: "1", uid, modseq: "1" },
    messageId: `<${uid}@example.test>`, subject: "A message", from: [], to: [],
    receivedAt: "2026-09-01T12:00:00.000Z", preview: "Indexed preview", read: false, flagged: true, ...overrides };
}
function page(messages: readonly ProviderMessageSummary[] = [], overrides: Partial<SyncPage> = {}): SyncPage {
  return { messages, removed: [], cursor: "checkpoint", hasMore: false, coverage: "partial", ...overrides };
}
async function fixture(path = ":memory:", kind: "imap" | "gmail" = "imap") {
  const store = new Store(path);
  cleanup.push(() => store.close());
  await store.insertAccount({ id: "account", kind, name: "Test", email: "test@example.test", encryptedCredentials: null });
  store.synchronization.schedule(tenant, "account", 0);
  const claim = store.synchronization.claim(tenant, 0, 100)!;
  store.synchronization.discover(claim, [kind === "imap" ? mailbox : { kind: "account" }], 0, 10);
  return { store, sync: store.synchronization, claim };
}
function commit(sync: Store["synchronization"], claim: SyncClaim, value: SyncPage, now = 1, scope = mailbox) {
  sync.commit(claim, scope, value, now, 10, 100);
}
async function runnerFixture(adapter: MailSynchronization, leaseMs = 100) {
  const harness = await createEmptyTestHarness();
  cleanup.push(() => harness.store.close());
  const account = await harness.service.createAccount(testAccountInput());
  expect(harness.store.synchronization.jobs(tenant)[0]?.account_id).toBe(account.id);
  const provider = harness.providerForAccount(account.id)!;
  const registry = new MailProviderRegistry();
  registry.register(account.id, Object.assign(provider, { synchronization: adapter }));
  let now = 0;
  const runner = new SynchronizationRunner(harness.store.synchronization, tenant, registry,
    { now: () => now, pollMs: 10, leaseMs });
  runner.schedule(account.id, true);
  return { ...harness, account, registry, runner, clock: (value: number) => { now = value; } };
}

describe("synchronization index", () => {
  test("replays observations, joins current flags, and retains canonical threading", async () => {
    const { store, sync, claim } = await fixture();
    commit(sync, claim, page([message("account", 1, { inReplyTo: "<parent@example.test>", references: ["<root@example.test>"] })]));
    const first = sync.indexed(tenant, "account", "INBOX")[0]!;
    commit(sync, claim, page([message("account", 1, { preview: "New preview", read: true, flagged: false })]), 2);
    const indexed = sync.indexed(tenant, "account", "INBOX");
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({ canonicalId: first.canonicalId, read: true, flagged: false, preview: "New preview", inReplyTo: "<parent@example.test>", references: ["<root@example.test>"] });
    expect(await store.listMessageLocations(tenant, first.canonicalId)).toHaveLength(1);
    expect(sync.indexed("other-tenant", "account", "INBOX")).toEqual([]);
  });

  test("merges an indexed fallback into an existing canonical message", async () => {
    const { sync, claim } = await fixture();
    commit(sync, claim, page([message("account", 1, { messageId: "" }), message("account", 2)]));
    const original = sync.indexed(tenant, "account", "INBOX").find(m => m.ref.uid === 1)!;
    commit(sync, claim, page([message("account", 1, { messageId: "<2@example.test>" })]), 2);
    const indexed = sync.indexed(tenant, "account", "INBOX");
    expect(new Set(indexed.map(m => m.canonicalId)).size).toBe(1);
    expect(indexed[0]!.canonicalAliases).toContain(original.canonicalId);
    expect(sync.retainedContentBytes(tenant, "account")).toBe(Buffer.byteLength(indexed[0]!.preview));
  });

  test("rolls back messages and checkpoint when a later snapshot is invalid", async () => {
    const { sync, claim } = await fixture();
    commit(sync, claim, page([message()]));
    expect(() => commit(sync, claim, page([message("account", 2)], { cursor: "bad", snapshots: [{ scope: mailbox, generation: "missing", phase: "complete", seen: [] }] }))).toThrow();
    expect(sync.indexed(tenant, "account", "INBOX").map(m => m.ref.uid)).toEqual([1]);
    expect(sync.scopes(claim)[0]!.cursor).toBe("checkpoint");
    expect(() => commit(sync, claim, page([message("foreign")]))).toThrow("scope");
    expect(() => commit(sync, claim, page([message("account", 3, { ref: { ...message().ref, mailbox: "Archive" } })]))).toThrow("scope");
  });

  test("partial snapshot preserves unseen locations; completion preserves newer observations", async () => {
    const { store, sync, claim } = await fixture();
    commit(sync, claim, page([message(), message("account", 2), message("account", 3)]));
    commit(sync, claim, page([], { cursor: "scan", hasMore: true, snapshots: [{ scope: mailbox, generation: "repair", phase: "start", seen: [] }] }), 2);
    expect(sync.indexed(tenant, "account", "INBOX")).toHaveLength(3);
    await store.reconcileMailbox({ tenantId: tenant, accountId: "account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [toCanonicalObservation(tenant, "imap", message("account", 2, { read: true }))] });
    commit(sync, claim, page([], { snapshots: [{ scope: mailbox, generation: "repair", phase: "complete", seen: [message().ref] }], coverage: "complete" }), 3);
    expect(sync.indexed(tenant, "account", "INBOX").map(m => m.ref.uid).sort()).toEqual([1, 2]);
  });

  test("account snapshot and exact Gmail labels do not affect another tenant", async () => {
    const { sync, claim } = await fixture(":memory:", "gmail");
    const scope: SyncScope = { kind: "account" };
    const gmail = (label: string) => message("account", 1, { ref: { ...message().ref, mailbox: label, providerId: "gmail-1" } });
    commit(sync, claim, page([gmail("INBOX"), gmail("Archive")]), 1, scope);
    sync.schedule("other", "account", 0);
    const other = sync.claim("other", 0, 100)!;
    sync.discover(other, [scope], 0, 10);
    commit(sync, other, page([gmail("INBOX")]), 1, scope);
    commit(sync, claim, page([], { locationSets: [{ providerId: "gmail-1", mailboxes: ["Archive"] }] }), 2, scope);
    expect(sync.indexed(tenant, "account", "INBOX")).toEqual([]);
    expect(sync.indexed("other", "account", "INBOX")).toHaveLength(1);
    commit(sync, claim, page([], { snapshots: [{ scope, generation: "empty", phase: "start-and-complete", seen: [] }] }), 3, scope);
    expect(sync.indexed(tenant, "account", "Archive")).toEqual([]);
    expect(sync.indexed("other", "account", "INBOX")).toHaveLength(1);
  });

  test("replayed starts preserve original revisions and completed scans cannot reopen", async () => {
    const { store, sync, claim } = await fixture();
    commit(sync, claim, page([message(), message("account", 2)]));
    const start = page([], { snapshots: [{ scope: mailbox, generation: "repair", phase: "start", seen: [message().ref] }] });
    commit(sync, claim, start, 2);
    await store.reconcileMailbox({ tenantId: tenant, accountId: "account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [toCanonicalObservation(tenant, "imap", message("account", 2, { read: true }))] });
    commit(sync, claim, start, 3);
    commit(sync, claim, page([], { snapshots: [{ scope: mailbox, generation: "repair", phase: "complete", seen: [] }] }), 4);
    expect(sync.indexed(tenant, "account", "INBOX").map(m => m.ref.uid).sort()).toEqual([1, 2]);
    commit(sync, claim, page([message("account", 3)]), 5);
    expect(() => commit(sync, claim, start, 6)).toThrow("already completed");
    commit(sync, claim, page([], { snapshots: [{ scope: mailbox, generation: "next-repair", phase: "start", seen: [] }] }), 7);
    expect(() => commit(sync, claim, start, 8)).toThrow("already completed");
    expect(sync.indexed(tenant, "account", "INBOX")).toHaveLength(3);
  });

  test("deduplicates physical copies before limiting and reads representative flags", async () => {
    const { store, sync, claim } = await fixture();
    commit(sync, claim, page([message("account", 3, { messageId: "<1@example.test>", read: true, flagged: false }),
      message("account", 1), message("account", 2, { receivedAt: "2026-08-01T12:00:00.000Z" })]));
    const indexed = sync.indexed(tenant, "account", "INBOX", 2);
    expect(indexed).toHaveLength(2);
    expect(new Set(indexed.map(m => m.canonicalId)).size).toBe(2);
    expect(indexed[0]).toMatchObject({ ref: { uid: 3 }, read: true, flagged: false });
    await store.reconcileMailbox({ tenantId: tenant, accountId: "account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [toCanonicalObservation(tenant, "imap", message("account", 3, { messageId: "<1@example.test>", read: false, flagged: true }))] });
    expect(sync.indexed(tenant, "account", "INBOX", 1)[0]).toMatchObject({ ref: { uid: 3 }, read: false, flagged: true });
  });

  test("persists committed cursor and repair evidence across restart and fences old claims", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postreeve-sync-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "index.sqlite");
    const first = await fixture(path);
    commit(first.sync, first.claim, page([message(), message("account", 2)]));
    commit(first.sync, first.claim, page([], { cursor: "scan-next", hasMore: true, snapshots: [{ scope: mailbox, generation: "restart", phase: "start", seen: [message().ref] }] }), 2);
    const second = new Store(path);
    cleanup.push(() => second.close());
    expect(second.synchronization.claim(tenant, 99, 100)).toBeNull();
    const resumed = second.synchronization.claim(tenant, 100, 100)!;
    expect(second.synchronization.scopes(resumed)[0]!.cursor).toBe("scan-next");
    expect(() => commit(first.sync, first.claim, page([message("account", 3)]), 101)).toThrow("expired");
    commit(second.synchronization, resumed, page([], { snapshots: [{ scope: mailbox, generation: "restart", phase: "complete", seen: [] }] }), 101);
    expect(second.synchronization.indexed(tenant, "account", "INBOX").map(m => m.ref.uid)).toEqual([1]);
    second.synchronization.fail(resumed, 102, "invalid-data", 10);
    const reopened = new Store(path);
    cleanup.push(() => reopened.close());
    expect(reopened.synchronization.jobs(tenant)[0]).toMatchObject({ error: "invalid-data", error_at: 102 });
    expect(reopened.synchronization.retainedContentBytes(tenant, "account")).toBe(2 * Buffer.byteLength("Indexed preview"));
  });

  test("accepts a full page with matching snapshot evidence but rejects oversized collections", async () => {
    const { sync, claim } = await fixture();
    const value = message();
    sync.commit(claim, mailbox, page([value], { snapshots: [{ scope: mailbox, generation: "one", phase: "start-and-complete", seen: [value.ref] }] }), 1, 10, 1);
    expect(() => sync.commit(claim, mailbox, page([value, message("account", 2)]), 2, 10, 1)).toThrow("limit");
    expect(() => commit(sync, claim, page([], { cursor: "checkpoint", hasMore: true }))).toThrow("progress");
  });
});

describe("durable synchronization runner", () => {
  test("runs without mailbox reads and retries from the committed page with exponential backoff", async () => {
    let failures = 0;
    const cursors: Array<string | null> = [];
    const harness = await runnerFixture({
      async discoverScopes() { return [mailbox]; },
      async fetchPage(request) {
        cursors.push(request.cursor);
        if (request.cursor === null) return page([message(request.account.accountId)], { cursor: "next", hasMore: true });
        if (failures++ < 2) throw new SynchronizationError("provider");
        return page([message(request.account.accountId, 2)], { cursor: "done", coverage: "complete" });
      },
    });
    await harness.runner.runOnce();
    await harness.runner.runOnce();
    expect(harness.store.synchronization.jobs(tenant)[0]).toMatchObject({ state: "retry", attempts: 1, due_at: 10, error: "provider" });
    expect(await harness.runner.runOnce()).toBe(false);
    harness.clock(10);
    await harness.runner.runOnce();
    expect(harness.store.synchronization.jobs(tenant)[0]).toMatchObject({ state: "retry", attempts: 2, due_at: 30 });
    harness.clock(30);
    await harness.runner.runOnce();
    expect(cursors).toEqual([null, "next", "next", "next"]);
    expect(harness.store.synchronization.indexed(tenant, harness.account.id, "INBOX")).toHaveLength(2);
    expect(harness.store.synchronization.jobs(tenant)[0]).toMatchObject({ state: "queued", attempts: 0, coverage: "complete" });
  });

  for (const action of ["cancel", "replace", "disconnect", "stop"] as const) {
    test(`${action} fences a late provider result`, async () => {
      const entered = Promise.withResolvers<void>();
      const delayed = Promise.withResolvers<SyncPage>();
      const harness = await runnerFixture({ async discoverScopes() { return [mailbox]; }, async fetchPage() { entered.resolve(); return delayed.promise; } });
      const running = harness.runner.runOnce();
      expect(harness.runner.runOnce()).toBe(running);
      await entered.promise;
      if (action === "cancel") harness.runner.cancel(harness.account.id);
      if (action === "replace") harness.runner.schedule(harness.account.id, true);
      if (action === "disconnect") await harness.service.removeAccount(harness.account.id);
      if (action === "stop") await harness.runner.stop();
      delayed.resolve(page([message(harness.account.id)]));
      await running;
      expect(harness.store.synchronization.indexed(tenant, harness.account.id, "INBOX")).toEqual([]);
      if (action === "cancel") expect(harness.store.synchronization.jobs(tenant)[0]!.state).toBe("canceled");
      if (action === "disconnect") expect(harness.store.synchronization.jobs(tenant)).toEqual([]);
    });
  }

  test("a lease-expired failure backs off but cannot overwrite a replacement claim", async () => {
    const { sync, claim } = await fixture();
    sync.fail(claim, 100, "provider", 10);
    expect(sync.jobs(tenant)[0]).toMatchObject({ state: "retry", due_at: 110, attempts: 1 });
    expect(sync.claim(tenant, 100, 100)).toBeNull();
    const replacement = sync.claim(tenant, 110, 100)!;
    sync.fail(claim, 111, "provider", 10);
    expect(sync.jobs(tenant)[0]).toMatchObject({ state: "running", generation: replacement.generation });
  });

  for (const action of ["cancel", "replacement"] as const) {
    test(`shutdown preserves ${action} during pending work`, async () => {
      const entered = Promise.withResolvers<void>();
      const delayed = Promise.withResolvers<SyncPage>();
      const harness = await runnerFixture({ async discoverScopes() { return [mailbox]; }, async fetchPage() { entered.resolve(); return delayed.promise; } });
      const running = harness.runner.runOnce();
      await entered.promise;
      if (action === "cancel") harness.runner.cancel(harness.account.id);
      else {
        harness.runner.schedule(harness.account.id, true);
        harness.store.synchronization.claim(tenant, 0, 100);
      }
      const before = harness.store.synchronization.jobs(tenant)[0]!;
      await harness.runner.stop();
      expect(harness.store.synchronization.jobs(tenant)[0]).toEqual(before);
      delayed.resolve(page([message(harness.account.id)]));
      await running;
      expect(harness.store.synchronization.indexed(tenant, harness.account.id, "INBOX")).toEqual([]);
    });
  }

  test("times out an uncooperative provider and persists a retry delay", async () => {
    const harness = await runnerFixture({
      async discoverScopes() { return [mailbox]; },
      async fetchPage() { harness.clock(1); return new Promise<SyncPage>(() => {}); },
    }, 1);
    await harness.runner.runOnce();
    expect(harness.store.synchronization.jobs(tenant)[0]).toMatchObject({ state: "retry", due_at: 11, attempts: 1 });
    expect(await harness.runner.runOnce()).toBe(false);
  });
});
