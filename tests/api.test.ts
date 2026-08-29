import { describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import { accountSchema, folderSchema, messageSummarySchema, proposalSchema } from "../src/shared/contracts";
import { createApi, type AppType } from "../src/server/api";
import { PostreeveService } from "../src/server/core/postreeve";
import { Store } from "../src/server/db/store";
import { MailProviderRegistry } from "../src/server/mail/provider";
import { MailSenderRegistry } from "../src/server/mail/sender";
import { CredentialVault } from "../src/server/security/credentials";

describe("Hono RPC API", () => {
  test("exposes the fixture mailbox through typed routes", async () => {
    const store = new Store(":memory:");
    const service = new PostreeveService(
      store,
      new MailProviderRegistry(),
      new MailSenderRegistry(),
      new CredentialVault(),
      () => { throw new Error("Not used in fixture tests"); },
      () => ({ send: async () => { throw new Error("Sending is not configured in this test"); } }),
    );
    await service.initialize();
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

  test("keeps approval on its explicit human-facing endpoint", async () => {
    const store = new Store(":memory:");
    const service = new PostreeveService(
      store,
      new MailProviderRegistry(),
      new MailSenderRegistry(),
      new CredentialVault(),
      () => { throw new Error("Not used in fixture tests"); },
      () => ({ send: async () => { throw new Error("Sending is not configured in this test"); } }),
    );
    await service.initialize();
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
