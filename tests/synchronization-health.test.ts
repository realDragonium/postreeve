import { afterEach, describe, expect, test } from "bun:test";
import { createApi } from "../src/server/api";
import { Store } from "../src/server/db/store";
import type { MailSynchronization, SyncPage } from "../src/server/mail/synchronization";
import { SynchronizationError } from "../src/server/mail/synchronization";
import type { ProviderMessageSummary } from "../src/server/mail/provider";
import { accountHealthSchema, synchronizationStatusSchema, reauthorizationSchema } from "../src/shared/synchronization";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));
const tenant = "test-tenant";
const emptyPage: SyncPage = { messages: [], removed: [], cursor: "complete", hasMore: false, coverage: "complete" };

async function harness() {
  let now = 0;
  const value = await createEmptyTestHarness({ synchronization: { now: () => now, pollMs: 10, leaseMs: 20 } });
  cleanup.push(() => value.store.close());
  const account = await value.service.createAccount(testAccountInput());
  let failure: unknown;
  let result = emptyPage;
  const adapter: MailSynchronization = {
    async discoverScopes() { return [{ kind: "mailbox", mailbox: "INBOX" }]; },
    async fetchPage() { if (failure) throw failure; return result; },
  };
  Object.assign(value.providerForAccount(account.id)!, { synchronization: adapter });
  return { ...value, account, clock: (time: number) => { now = time; },
    fail: (error: unknown) => { failure = error; }, page: (page: SyncPage) => { result = page; },
    health: async () => (await value.service.synchronizationStatus()).accounts[0]! };
}

describe("synchronization health and recovery", () => {
  test("retains sanitized failure across explicit retry and clears it on successful progress", async () => {
    const h = await harness();
    expect((await h.health()).state).toBe("catching-up");
    h.fail(new Error("secret-password should never appear"));
    await h.service.synchronization.runOnce();
    expect(await h.health()).toMatchObject({ state: "degraded", failure: { kind: "provider", at: 0 } });
    expect(JSON.stringify(await h.health())).not.toContain("secret-password");
    const retry = await h.service.retrySynchronization(h.account.id);
    expect(retry.failure?.kind).toBe("provider");
    h.fail(undefined);
    await h.service.synchronization.runOnce();
    expect(await h.health()).toMatchObject({ state: "healthy", lastSuccessAt: 0, failure: null });
    h.clock(51);
    expect((await h.health()).state).toBe("degraded");
    h.service.synchronization.cancel(h.account.id);
    expect((await h.health()).state).toBe("disconnected");
  });

  for (const error of [new SynchronizationError("reauthorization"), Object.assign(new Error("private server auth text"), { authenticationFailed: true })]) {
    test(`pauses automatic authentication retries and allows explicit recovery: ${error.constructor.name}`, async () => {
      const h = await harness();
      h.fail(error);
      await h.service.synchronization.runOnce();
      expect((await h.health()).state).toBe("reauthorization-required");
      h.clock(100);
      expect(await h.service.synchronization.runOnce()).toBe(false);
      expect((await h.health()).failure?.at).toBe(0);
      await h.service.retrySynchronization(h.account.id);
      h.fail(undefined);
      expect(await h.service.synchronization.runOnce()).toBe(true);
      expect((await h.health()).state).toBe("healthy");
    });
  }

  test("manual retry refreshes a not-yet-due scope and discovery alone cannot clear a failure", async () => {
    const h = await harness();
    await h.service.synchronization.runOnce();
    h.fail(new SynchronizationError("invalid-data"));
    await h.service.retrySynchronization(h.account.id);
    expect(await h.service.synchronization.runOnce()).toBe(true);
    expect((await h.health()).failure?.kind).toBe("invalid-data");
    Object.assign(h.providerForAccount(h.account.id)!, { synchronization: {
      async discoverScopes() { return []; }, async fetchPage() { return emptyPage; },
    } satisfies MailSynchronization });
    await h.service.retrySynchronization(h.account.id);
    h.clock(1);
    await h.service.synchronization.runOnce();
    expect(await h.health()).toMatchObject({ state: "degraded", lastSuccessAt: 0, failure: { kind: "invalid-data" } });
  });

  test("unavailable stored account does not block other accounts and recovery exposes no credentials", async () => {
    const h = await harness();
    await h.store.insertAccount({ id: "broken", kind: "gmail", name: "Unavailable", email: "broken@example.test", encryptedCredentials: null });
    await h.service.initialize();
    const app = createApi(h.service);
    const response = await app.request("/api/synchronization");
    const status = synchronizationStatusSchema.parse(await response.json());
    expect(status.accounts.find(item => item.account.id === "broken")?.state).toBe("disconnected");
    expect(status.accounts.find(item => item.account.id === h.account.id)?.state).toBe("catching-up");
    const retry = await app.request(`/api/accounts/${h.account.id}/synchronization/retry`, { method: "POST" });
    expect(accountHealthSchema.parse(await retry.json()).account.id).toBe(h.account.id);
    const reauthorize = await app.request(`/api/accounts/${h.account.id}/reauthorization`, { method: "POST" });
    expect(reauthorizationSchema.parse(await reauthorize.json()).method).toBe("account-settings");
    const gmail = await app.request("/api/accounts/broken/reauthorization", { method: "POST" });
    expect(reauthorizationSchema.parse(await gmail.json()).method).toBe("google-consent");
    expect(JSON.stringify(status)).not.toContain("encryptedCredentials");
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
  });
});

function message(accountId: string, uid: number, preview: string): ProviderMessageSummary {
  return { ref: { accountId, mailbox: "INBOX", uidValidity: "1", uid, modseq: null }, messageId: `<${uid}@example.test>`,
    subject: `Retained header ${uid}`, from: [], to: [], receivedAt: "2026-10-01T00:00:00.000Z", preview, read: false, flagged: true };
}

describe("preview retention", () => {
  test("enforces UTF-8 bytes and age per account without changing canonical identity, flags or other tenants", async () => {
    const store = new Store(":memory:"); cleanup.push(() => store.close());
    const sync = store.synchronization;
    sync.configureRetention({ maxAgeDays: 1, maxContentBytes: 5 });
    for (const id of ["a", "b"]) await store.insertAccount({ id, kind: "imap", name: id, email: `${id}@example.test`, encryptedCredentials: null });
    const seed = (owner: string, accountId: string) => {
      sync.schedule(owner, accountId, 0);
      const claim = sync.claim(owner, 0, 100)!;
      sync.discover(claim, [{ kind: "mailbox", mailbox: "INBOX" }], 0, 10);
      sync.commit(claim, { kind: "mailbox", mailbox: "INBOX" }, { ...emptyPage, messages: [message(accountId, 1, "éé")] }, 1, 10, 100);
      return claim;
    };
    const claim = seed(tenant, "a"); seed("other", "a"); seed(tenant, "b");
    const before = sync.indexed(tenant, "a", "INBOX")[0]!;
    sync.commit(claim, { kind: "mailbox", mailbox: "INBOX" }, { ...emptyPage, messages: [message("a", 2, "abc")] }, 2, 10, 100);
    expect(sync.retainedContentBytes(tenant, "a")).toBe(3);
    expect(sync.indexed(tenant, "a", "INBOX").find(item => item.ref.uid === 1)).toMatchObject({
      canonicalId: before.canonicalId, conversationId: before.conversationId, subject: before.subject, preview: "", read: false, flagged: true,
    });
    sync.enforceRetention(tenant, "a", 86_400_002);
    expect(sync.retainedContentBytes(tenant, "a")).toBe(0);
    expect(sync.indexed(tenant, "a", "INBOX")).toHaveLength(2);
    expect(sync.retainedContentBytes("other", "a")).toBe(4);
    expect(sync.retainedContentBytes(tenant, "b")).toBe(4);
    expect(await store.getMessage(tenant, before.canonicalId)).not.toBeNull();
  });

  test("background maintenance expires content while authorization is paused", async () => {
    const h = await harness();
    h.store.synchronization.configureRetention({ maxAgeDays: 1, maxContentBytes: 100 });
    h.page({ ...emptyPage, messages: [message(h.account.id, 1, "content")] });
    await h.service.synchronization.runOnce();
    h.clock(10); h.fail(new SynchronizationError("reauthorization"));
    await h.service.synchronization.runOnce();
    h.clock(86_400_001);
    expect(await h.service.synchronization.runOnce()).toBe(false);
    expect(h.store.synchronization.retainedContentBytes(tenant, h.account.id)).toBe(0);
    expect(h.store.synchronization.indexed(tenant, h.account.id, "INBOX")).toHaveLength(1);
  });
});
