import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/db/store";
import { createApi } from "../src/server/api";
import type { ProviderMessageSummary } from "../src/server/mail/provider";
import type { OutboundAddress } from "../src/shared/contracts";
import { createTestHarness } from "./support/test-mail";

const tenant = "test-tenant";
const now = new Date("2026-06-01T00:00:00.000Z");
const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

let uid = 0;
function mail(accountId: string, from: OutboundAddress, to: OutboundAddress[], extra: Partial<ProviderMessageSummary> = {}): ProviderMessageSummary {
  uid += 1;
  return { ref: { accountId, mailbox: "INBOX", uidValidity: "1", uid, modseq: "1" }, messageId: `<${uid}@suggest.test>`,
    subject: "Hello", from: [from], to, receivedAt: "2026-05-01T00:00:00.000Z", preview: "Preview", read: false, flagged: false, ...extra };
}
const me = (accountId: string) => ({ name: "Me", address: `${accountId}@me.test` });
const person = (address: string, name = "") => ({ name, address });

async function fixture(path = ":memory:") {
  const store = new Store(path); close.push(() => store.close());
  for (const id of ["a", "b"]) {
    await store.insertAccount({ id, kind: "imap", name: id, email: `${id}@me.test`, encryptedCredentials: null });
    store.synchronization.schedule(tenant, id, 0);
  }
  const index = (accountId: string, messages: ProviderMessageSummary[]) =>
    store.synchronization.observe({ tenantId: tenant, accountId, provider: "imap" }, messages, 1000);
  const suggest = (q: string, limit = 8) => store.recipientSuggestions(tenant, { q, limit }, now);
  return { store, index, suggest };
}

describe("recipient suggestions", () => {
  test("rank sent-to addresses above senders, prefix matches first, and match names case-insensitively", async () => {
    const { index, suggest } = await fixture();
    index("a", [
      mail("a", me("a"), [person("ann@x.test")]),
      ...Array.from({ length: 5 }, () => mail("a", person("anna@x.test"), [me("a")])),
      mail("a", person("joanne@x.test", "Jo Annesley"), [me("a")]),
      mail("a", person("zed@x.test", "Alice Example"), [me("a")]),
    ]);
    expect(suggest("ann").map(s => s.address)).toEqual(["ann@x.test", "anna@x.test", "joanne@x.test"]);
    expect(suggest("LIC")).toEqual([{ name: "Alice Example", address: "zed@x.test" }]);
    expect(suggest("x.test", 2)).toHaveLength(2);
  });

  test("merge accounts by address with the most recent name and exclude own addresses and identities", async () => {
    const { store, index, suggest } = await fixture();
    index("a", [mail("a", person("Bob@X.test", "Bobby"), [me("a"), person("b@me.test")], { receivedAt: "2026-01-01T00:00:00.000Z" })]);
    index("b", [mail("b", person("bob@x.test", "Robert"), [me("b")], { receivedAt: "2026-03-01T00:00:00.000Z" }),
      mail("b", person("sales@me.test"), [me("b")])]);
    expect(suggest("bob")).toEqual([{ name: "Robert", address: "bob@x.test" }]);
    expect(suggest("me.test")).toHaveLength(1);
    await store.addIdentity(tenant, { id: "i1", accountId: "b", name: "Sales", address: "sales@me.test", createdAt: now.toISOString() }, 10);
    expect(suggest("me.test")).toEqual([]);
  });

  test("follow index removal and retention, and drop an account's contribution when it is removed", async () => {
    const { store, index, suggest } = await fixture();
    index("a", [mail("a", person("erin@x.test"), [me("a")]), mail("a", me("a"), [person("dave@x.test")])]);
    index("b", [mail("b", person("erin@x.test"), [me("b")])]);
    const sync = store.synchronization;
    sync.configureRetention({ maxAgeDays: 1, maxContentBytes: 100000 });
    sync.enforceRetention(tenant, "a", 1000 + 2 * 86_400_000);
    expect(suggest("erin").map(s => s.address)).toEqual(["erin@x.test"]);
    sync.sqlite.query("DELETE FROM indexed_messages WHERE account_id='b'").run();
    expect(suggest("erin")).toHaveLength(1);
    expect(await store.deleteAccount("a")).toBe(true);
    expect(suggest("erin")).toEqual([]);
    expect(suggest("dave")).toEqual([]);
  });

  test("changed headers move a message's contribution", async () => {
    const { index, suggest } = await fixture();
    const original = mail("a", person("first@x.test"), [me("a")]);
    index("a", [original]);
    index("a", [{ ...original, from: [person("second@x.test")] }]);
    expect(suggest("x.test").map(s => s.address)).toEqual(["second@x.test"]);
  });

  test("backfills an index created before suggestions existed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postreeve-suggest-"));
    close.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "index.sqlite");
    const first = await fixture(path);
    first.index("a", [mail("a", me("a"), [person("cat@x.test", "Cat")])]);
    first.store.synchronization.sqlite.exec(`DROP TRIGGER correspondents_insert; DROP TRIGGER correspondents_delete;
      DROP TRIGGER correspondents_update; DROP TABLE correspondents`);
    first.store.close();
    const reopened = new Store(path); close.push(() => reopened.close());
    expect(reopened.recipientSuggestions(tenant, { q: "cat" }, now)).toEqual([{ name: "Cat", address: "cat@x.test" }]);
  });

  test("API validates the query and answers from local data", async () => {
    const harness = await createTestHarness(); close.push(() => harness.store.close());
    harness.store.synchronization.observe({ tenantId: tenant, accountId: harness.account.id, provider: "imap" },
      [mail(harness.account.id, person("fran@x.test", "Fran"), [{ name: "", address: harness.account.email }])], 1000);
    const api = createApi(harness.service);
    const ok = await api.request("/api/recipient-suggestions?q=fran");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([{ name: "Fran", address: "fran@x.test" }]);
    for (const query of ["q=%20", `q=${"a".repeat(101)}`, "q=a&limit=21", "q=a&limit=0", ""]) {
      expect((await api.request(`/api/recipient-suggestions?${query}`)).status).toBe(400);
    }
  });
});
