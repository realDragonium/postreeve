import { describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import { accountSchema, folderSchema, messageSummarySchema, proposalSchema } from "../src/shared/contracts";
import { createApi, type AppType } from "../src/server/api";
import { createTestHarness } from "./support/test-mail";

describe("Hono RPC API", () => {
  test("exposes an account mailbox through typed routes", async () => {
    const { store, service } = await createTestHarness();
    const app = createApi(service);
    const client = hc<AppType>("http://postreeve.local", { fetch: app.request });

    const accountsResponse = await client.api.accounts.$get();
    expect(accountsResponse.status).toBe(200);
    const account = accountSchema.array().parse(await accountsResponse.json())[0]!;
    const foldersResponse = await client.api.accounts[":accountId"].folders.$get({
      param: { accountId: account.id },
    });
    expect(folderSchema.array().parse(await foldersResponse.json()).map(({ specialUse }) => specialUse)).toContain("trash");
    const messagesResponse = await client.api.accounts[":accountId"].messages.$get({
      param: { accountId: account.id },
      query: { mailbox: "INBOX", limit: "20" },
    });
    expect(messageSummarySchema.array().parse(await messagesResponse.json()).length).toBeGreaterThan(0);
    store.close();
  });

  test("manages custom folders through typed routes", async () => {
    const { store, service } = await createTestHarness();
    const app = createApi(service);
    const client = hc<AppType>("http://postreeve.local", { fetch: app.request });
    const account = accountSchema.array().parse(await (await client.api.accounts.$get()).json())[0]!;

    const createdResponse = await client.api.accounts[":accountId"].folders.$post({
      param: { accountId: account.id },
      json: { name: "Projects" },
    });
    expect(createdResponse.status).toBe(201);
    expect(folderSchema.array().parse(await createdResponse.json()).some(({ path }) => path === "Projects")).toBe(true);

    const renamedResponse = await client.api.accounts[":accountId"].folders.$put({
      param: { accountId: account.id },
      json: { path: "Projects", name: "Clients" },
    });
    expect(folderSchema.array().parse(await renamedResponse.json()).some(({ path }) => path === "Clients")).toBe(true);

    const deletedResponse = await client.api.accounts[":accountId"].folders.$delete({
      param: { accountId: account.id },
      json: { path: "Clients" },
    });
    expect(folderSchema.array().parse(await deletedResponse.json()).some(({ path }) => path === "Clients")).toBe(false);
    store.close();
  });

  test("keeps approval on its explicit human-facing endpoint", async () => {
    const { store, service } = await createTestHarness();
    const app = createApi(service);
    const client = hc<AppType>("http://postreeve.local", { fetch: app.request });
    const account = accountSchema.array().parse(await (await client.api.accounts.$get()).json())[0]!;
    const message = messageSummarySchema.array().parse(await (await client.api.accounts[":accountId"].messages.$get({
      param: { accountId: account.id },
      query: { mailbox: "INBOX", limit: "1" },
    })).json())[0]!;
    const created = proposalSchema.parse(await (await client.api.proposals.$post({ json: {
      accountId: account.id,
      title: "Typed API proposal",
      items: [{
        id: "item-1",
        message: message.ref,
        subject: message.subject,
        action: { type: "mark_read" },
        reason: "Test",
      }],
    } })).json());

    const rejected = await client.api.proposals[":proposalId"].apply.$post({ param: { proposalId: created.id } });
    expect(rejected.status).toBe(400);
    const approved = await client.api.proposals[":proposalId"].approve.$post({ param: { proposalId: created.id } });
    expect(proposalSchema.parse(await approved.json()).status).toBe("approved");
    store.close();
  });
});
