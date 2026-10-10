import { describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import { createApi, type AppType } from "../src/server/api";
import { identitySchema, type Account } from "../src/shared/contracts";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

async function harnessWithAccount() {
  const harness = await createEmptyTestHarness();
  const account = await harness.service.createAccount(testAccountInput());
  return { ...harness, account };
}

function draftFrom(account: Account, identity: { name: string; address: string }) {
  return {
    accountId: account.id,
    mode: "new" as const,
    to: "alice@example.test",
    cc: "",
    bcc: "",
    subject: "Hello",
    body: "Hi Alice",
    identity,
    attachments: [],
  };
}

describe("sender identities", () => {
  test("adds, lists and removes identities through the API", async () => {
    const { service, store, account } = await harnessWithAccount();
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const param = { accountId: account.id };

    const created = await client.api.accounts[":accountId"].identities.$post({
      param, json: { name: " Sales ", address: "Sales@Example.test" },
    });
    expect(created.status).toBe(201);
    const identity = identitySchema.parse(await created.json());
    expect(identity).toMatchObject({ name: "Sales", address: "sales@example.test" });

    const repeated = await client.api.accounts[":accountId"].identities.$post({
      param, json: { name: "Other", address: "SALES@example.test" },
    });
    expect(repeated.status).toBe(200);
    expect(identitySchema.parse(await repeated.json())).toEqual(identity);

    const primary = await client.api.accounts[":accountId"].identities.$post({
      param, json: { name: "Me", address: account.email.toUpperCase() },
    });
    expect(primary.status).toBe(400);

    const listed = await client.api.accounts[":accountId"].identities.$get({ param });
    expect(identitySchema.array().parse(await listed.json())).toEqual([identity]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const removed = await client.api.accounts[":accountId"].identities[":identityId"].$delete({
        param: { ...param, identityId: identity.id },
      });
      expect(removed.status).toBe(200);
    }
    expect(await service.listIdentities(account.id)).toEqual([]);
    store.close();
  });

  test("refuses identities for unknown accounts and removes them with their account", async () => {
    const { service, store, account } = await harnessWithAccount();
    await expect(service.listIdentities("missing")).rejects.toThrow("Account not found");
    await service.addIdentity(account.id, { name: "Sales", address: "sales@example.test" });

    await service.removeAccount(account.id);
    const again = await service.createAccount(testAccountInput());
    expect(await store.listIdentities("test-tenant", account.id)).toEqual([]);
    expect(await service.listIdentities(again.id)).toEqual([]);
    store.close();
  });

  test("sends a draft from a stored identity, using its stored name when the draft has none", async () => {
    const { service, store, account, sent } = await harnessWithAccount();
    await service.addIdentity(account.id, { name: "Sales", address: "sales@example.test" });
    const draft = await service.createDraft(draftFrom(account, { name: "", address: "sales@example.test" }));

    await service.sendDraft(account.id, draft.id, { version: draft.version });

    expect(sent[0]?.from).toEqual({ name: "Sales", address: "sales@example.test" });
    store.close();
  });

  test("refuses a draft whose identity is not stored for the account", async () => {
    const { service, store, account, sendAttempts } = await harnessWithAccount();
    const draft = await service.createDraft(draftFrom(account, { name: "Other", address: "other@example.test" }));

    await expect(service.sendDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("Draft identity does not belong to the selected account");
    expect(sendAttempts).toEqual([]);
    store.close();
  });

  test("sends direct messages from the primary address", async () => {
    const { service, store, account, sent } = await harnessWithAccount();
    await service.sendMessage({
      accountId: account.id, to: [{ name: "", address: "alice@example.test" }], cc: [], bcc: [], subject: "Hi", text: "Hi",
    });
    expect(sent[0]?.from).toEqual({ name: account.name, address: account.email });
    store.close();
  });
});
