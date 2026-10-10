import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../src/server/db/store";
import { MailProviderRegistry, type MailProvider, type ProviderMessageSummary } from "../src/server/mail/provider";
import type { MailSynchronization, SyncPage, SyncScope } from "../src/server/mail/synchronization";
import { SynchronizationRunner } from "../src/server/sync/runner";
import { ProviderWatches } from "../src/server/sync/watches";
import type { MailboxEvent } from "../src/shared/mailbox-events";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

const tenant = "test-tenant";
const inbox: SyncScope = { kind: "mailbox", mailbox: "INBOX" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function message(uid: number, overrides: Partial<ProviderMessageSummary> = {}): ProviderMessageSummary {
  return { ref: { accountId: "account", mailbox: "INBOX", uidValidity: "1", uid, modseq: null },
    messageId: `<${uid}@example.test>`, subject: `Subject ${uid}`, from: [{ name: "Ada", address: "ada@example.test" }], to: [],
    receivedAt: "2026-09-01T12:00:00.000Z", preview: "", read: false, flagged: false, ...overrides };
}
function page(messages: readonly ProviderMessageSummary[], overrides: Partial<SyncPage> = {}): SyncPage {
  return { messages, removed: [], cursor: "checkpoint", hasMore: false, coverage: "complete", ...overrides };
}

async function fixture(kind: "imap" | "gmail" = "imap") {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  await store.insertAccount({ id: "account", kind, name: "Test", email: "test@example.test", encryptedCredentials: null });
  const sync = store.synchronization;
  sync.schedule(tenant, "account", 0);
  const claim = sync.claim(tenant, 0, 1_000)!;
  const scope: SyncScope = kind === "imap" ? inbox : { kind: "account" };
  sync.discover(claim, [scope], 0, 10);
  let now = 1;
  const commit = (value: SyncPage) => sync.commit(claim, scope, value, now++, 10, 100);
  return { store, sync, claim, scope, commit };
}

describe("new arrivals", () => {
  test("backfill is silent; later unread Inbox mail is an arrival", async () => {
    const { commit, scope } = await fixture();
    expect(commit(page([message(1), message(2)], { snapshots: [{ scope, generation: "first", phase: "start-and-complete", seen: [] }] }))).toEqual([]);
    expect(commit(page([message(3)]))).toEqual([expect.objectContaining({ mailbox: "INBOX", sender: "Ada", subject: "Subject 3" })]);
  });

  test("known, read and repeated messages are not arrivals", async () => {
    const { commit, scope } = await fixture();
    commit(page([message(1)], { snapshots: [{ scope, generation: "first", phase: "start-and-complete", seen: [] }] }));
    expect(commit(page([message(1, { ref: { ...message(1).ref, uid: 9 } })]))).toEqual([]);
    expect(commit(page([message(2, { read: true })]))).toEqual([]);
    expect(commit(page([message(3)]))).toHaveLength(1);
    expect(commit(page([message(3)]))).toEqual([]);
  });

  test("a Gmail message reports one arrival across its label rows and none for other labels only", async () => {
    const { commit, scope } = await fixture("gmail");
    commit(page([], { snapshots: [{ scope, generation: "full", phase: "start-and-complete", seen: [] }] }));
    const labelled = (id: string, mailbox: string) => message(1, { messageId: `<${id}@example.test>`,
      ref: { accountId: "account", mailbox, uidValidity: "gmail", uid: 1, modseq: null, providerId: id } });
    expect(commit(page([labelled("a", "Label_1"), labelled("a", "INBOX")]))).toHaveLength(1);
    expect(commit(page([labelled("b", "Label_1")]))).toEqual([]);
  });

  test("a replaced job is not ready until its repair completes", async () => {
    const { sync, scope } = await fixture();
    sync.schedule(tenant, "account", 5, true);
    const claim = sync.claim(tenant, 5, 1_000)!;
    sync.discover(claim, [scope], 5, 10);
    expect(sync.commit(claim, scope, page([message(7)]), 6, 10, 100)).toEqual([]);
  });
});

describe("expedite", () => {
  test("makes a queued scope and job due now, but leaves paused jobs alone", async () => {
    const { sync, claim, scope } = await fixture();
    sync.commit(claim, scope, page([]), 1, 1_000, 100);
    sync.finish(claim, 2, 1_000);
    expect(sync.jobs(tenant)[0]!.due_at).toBeGreaterThan(100);
    expect(sync.expedite(tenant, "account", { kind: "mailbox", mailbox: "Unknown" }, 50)).toBe(false);
    expect(sync.expedite(tenant, "account", inbox, 50)).toBe(true);
    expect(sync.jobs(tenant)[0]!.due_at).toBe(50);
    expect(sync.scopes(claim)[0]!.due_at).toBe(50);

    const paused = sync.claim(tenant, 50, 1_000)!;
    sync.fail(paused, 60, "reauthorization", 10_000);
    sync.expedite(tenant, "account", inbox, 70);
    expect(sync.jobs(tenant)[0]).toMatchObject({ state: "retry", due_at: 10_060 });
    expect(sync.claim(tenant, 70, 1_000)).toBeNull();
  });
});

async function runnerFixture(adapter: MailSynchronization, kind: "imap" | "gmail" = "imap") {
  const harness = await createEmptyTestHarness();
  cleanup.push(() => harness.store.close());
  const account = await harness.service.createAccount(testAccountInput());
  if (kind === "gmail") harness.store.synchronization.sqlite.query("UPDATE sync_jobs SET provider='gmail'").run();
  const registry = new MailProviderRegistry();
  registry.register(account.id, Object.assign(harness.providerForAccount(account.id)!, { synchronization: adapter }));
  let now = 0;
  const runner = new SynchronizationRunner(harness.store.synchronization, tenant, registry, { now: () => now, pollMs: 60_000, gmailPollMs: 20_000 });
  const events: MailboxEvent[] = [];
  runner.events.subscribe(event => events.push(event));
  runner.schedule(account.id, true);
  return { ...harness, account, runner, events, clock: (value: number) => { now = value; } };
}

describe("runner", () => {
  test("publishes change and arrival events and an expedited Inbox runs before its poll", async () => {
    let uid = 0;
    const harness = await runnerFixture({
      async discoverScopes() { return [inbox]; },
      async fetchPage(request) {
        uid++;
        const value = message(uid, { ref: { ...message(uid).ref, accountId: request.account.accountId } });
        return page([value], uid === 1 ? { snapshots: [{ scope: inbox, generation: "first", phase: "start-and-complete",
          seen: [value.ref] }] } : {});
      },
    });
    await harness.runner.runOnce();
    expect(harness.events).toEqual([{ type: "mailbox-changed", accountId: harness.account.id }]);
    harness.clock(1_000);
    expect(await harness.runner.runOnce()).toBe(false);
    harness.runner.expedite(harness.account.id, "INBOX");
    expect(await harness.runner.runOnce()).toBe(true);
    expect(harness.events.at(-1)).toMatchObject({ type: "new-mail", accountId: harness.account.id, arrivals: [{ subject: "Subject 2" }] });
  });

  test("Gmail scopes become due after the Gmail poll interval", async () => {
    const harness = await runnerFixture({
      async discoverScopes() { return [{ kind: "account" }]; },
      async fetchPage() { return page([]); },
    }, "gmail");
    await harness.runner.runOnce();
    expect(harness.store.synchronization.jobs(tenant)[0]!.due_at).toBe(20_000);
  });
});

describe("provider watches", () => {
  function watchingProvider() {
    const started: Array<(mailbox: string) => void> = [];
    let stopped = 0;
    const provider = { watchChanges(onChange: (mailbox: string) => void) { started.push(onChange); return { stop: () => { stopped++; } }; } };
    return { provider: provider as Pick<MailProvider, "watchChanges"> as MailProvider, started, stopped: () => stopped };
  }
  type Job = Parameters<ProviderWatches["reconcile"]>[0][number];
  const job = (overrides: Partial<Job> = {}): Job => ({ tenant_id: tenant, account_id: "account", provider: "imap", state: "queued",
    generation: "g", due_at: 0, lease_until: null, attempts: 0, error: null, coverage: "complete", updated_at: 0, error_at: null,
    last_success_at: null, provider_unavailable: 0, ...overrides });

  test("start once, forward changes, stop for paused accounts and restart for a replaced provider", () => {
    const registry = new MailProviderRegistry();
    const first = watchingProvider();
    registry.register("account", first.provider);
    const changes: string[] = [];
    const watches = new ProviderWatches(registry, (accountId, mailbox) => changes.push(`${accountId}:${mailbox}`));
    watches.reconcile([job()]);
    watches.reconcile([job()]);
    expect(first.started).toHaveLength(1);
    first.started[0]!("INBOX");
    expect(changes).toEqual(["account:INBOX"]);

    for (const paused of [job({ state: "canceled" }), job({ provider_unavailable: 1 }), job({ state: "retry", error: "reauthorization" })]) {
      watches.reconcile([paused]);
      watches.reconcile([job()]);
    }
    expect(first.stopped()).toBe(3);
    expect(first.started).toHaveLength(4);

    const second = watchingProvider();
    registry.register("account", second.provider);
    watches.reconcile([job()]);
    expect(first.stopped()).toBe(4);
    expect(second.started).toHaveLength(1);
    registry.remove("account");
    watches.reconcile([]);
    expect(second.stopped()).toBe(1);
  });

  test("a provider without watch support is left to polling", () => {
    const registry = new MailProviderRegistry();
    registry.register("account", {} as MailProvider);
    const watches = new ProviderWatches(registry, () => undefined);
    expect(() => watches.reconcile([job()])).not.toThrow();
  });
});

