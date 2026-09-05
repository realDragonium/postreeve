import { describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import {
  accountSchema,
  canonicalMessageDetailSchema,
  canonicalMessageSummarySchema,
  canonicalConversationSchema,
  folderSchema,
  messageSummarySchema,
  proposalSchema,
} from "../src/shared/contracts";
import { createApi, oauthResultUrl, type AppType } from "../src/server/api";
import { createEmptyTestHarness, createTestHarness, testAccountInput } from "./support/test-mail";

describe("Hono RPC API", () => {
  test("returns OAuth results to the active web client", () => {
    expect(oauthResultUrl(undefined, "error")).toBe("/?google=error");
    expect(oauthResultUrl("postreeve://app/", "connected", "account one"))
      .toBe("postreeve://app/?google=connected&accountId=account+one");
  });

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
    const messages = canonicalMessageSummarySchema.array().parse(await messagesResponse.json());
    expect(messages.length).toBeGreaterThan(0);
    const readResponse = await client.api.messages.read.$post({ json: { references: [messages[0]!.ref] } });
    const details = canonicalMessageDetailSchema.array().parse(await readResponse.json());
    expect(details[0]).toMatchObject({ canonicalId: messages[0]!.canonicalId, ref: messages[0]!.ref });
    const conversationResponse = await client.api.conversations[":conversationId"].$get({
      param: { conversationId: messages[0]!.conversationId },
    });
    const conversation = canonicalConversationSchema.parse(await conversationResponse.json());
    expect(conversation.messages.map(({ id }) => id)).toContain(messages[0]!.canonicalId);
    store.close();
  });

  test("returns one canonical summary for duplicate deliveries in list and search responses", async () => {
    const { store, service } = await createEmptyTestHarness({ duplicateDelivery: true });
    const account = await service.createAccount(testAccountInput());
    const app = createApi(service);
    const client = hc<AppType>("http://postreeve.local", { fetch: app.request });

    const listResponse = await client.api.accounts[":accountId"].messages.$get({
      param: { accountId: account.id },
      query: { mailbox: "INBOX", limit: "50" },
    });
    const searchResponse = await client.api.accounts[":accountId"].messages.$get({
      param: { accountId: account.id },
      query: { mailbox: "INBOX", query: "planning", limit: "50" },
    });
    const listed = canonicalMessageSummarySchema.array().parse(await listResponse.json());
    const searched = canonicalMessageSummarySchema.array().parse(await searchResponse.json());

    expect(listed.filter(({ messageId }) => messageId === "<message-103@example.test>")).toHaveLength(1);
    expect(searched).toHaveLength(1);
    expect(searched[0]?.canonicalId).toBe(listed[0]?.canonicalId);
    store.close();
  });

  test("exposes one conversation for quoted-pair-equivalent IMAP deliveries and their reply", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const location = (mailbox: string, uid: number) => ({
      accountId: account.id, provider: "imap" as const, mailbox, uidValidity: "1", uid,
      modseq: null, providerId: null, read: false, flagged: false,
    });
    const [plain] = await store.reconcileMailbox({
      tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{ tenantId: "test-tenant", messageId: '<"ab"@Example.Test>', inReplyTo: null,
        references: [], location: location("INBOX", 1) }],
    });
    const [escaped] = await store.reconcileMailbox({
      tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "Archive", authoritative: false,
      observations: [{ tenantId: "test-tenant", messageId: '<"a\\b"@example.test>', inReplyTo: null,
        references: [], location: location("Archive", 2) }],
    });
    const [reply] = await store.reconcileMailbox({
      tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{ tenantId: "test-tenant", messageId: "<reply@example.test>",
        inReplyTo: '<"a\\b"@example.test>', references: ['<"ab"@example.test>'],
        location: location("INBOX", 3) }],
    });
    const response = await createApi(service).request(`/api/conversations/${reply!.conversationId}`);
    const conversation = canonicalConversationSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(escaped!.id).toBe(plain!.id);
    expect(await store.listMessageLocations("test-tenant", plain!.id)).toHaveLength(2);
    expect(conversation.messages.map(({ messageId }) => messageId)).toEqual([
      "<ab@example.test>", "<reply@example.test>",
    ]);
    store.close();
  });

  test("persists a complete 100,000-ID References observation beyond SQLite's binding limit", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const referenceCount = 100_000;
    const references = Array.from({ length: referenceCount }, (_, index) =>
      `<reference-${index.toString().padStart(6, "0")}@example.test>`);
    const lateParentMessageId = references[referenceCount - 1]!;
    const location = (uid: number) => ({
      accountId: account.id,
      provider: "imap" as const,
      mailbox: "INBOX",
      uidValidity: "large-references",
      uid,
      modseq: null,
      providerId: null,
      read: false,
      flagged: false,
    });
    const childObservation = {
      tenantId: "test-tenant",
      messageId: "<large-child@example.test>",
      inReplyTo: null,
      references,
      location: location(1),
    };
    const [child] = await store.reconcileMailbox({
      tenantId: "test-tenant",
      accountId: account.id,
      provider: "imap",
      mailbox: "INBOX",
      observations: [childObservation],
      authoritative: false,
    });

    await store.reconcileMailbox({
      tenantId: "test-tenant",
      accountId: account.id,
      provider: "imap",
      mailbox: "INBOX",
      observations: [{ ...childObservation, references: [] }],
      authoritative: false,
    });
    const [lateParent] = await store.reconcileMailbox({
      tenantId: "test-tenant",
      accountId: account.id,
      provider: "imap",
      mailbox: "INBOX",
      observations: [{
        tenantId: "test-tenant",
        messageId: lateParentMessageId,
        inReplyTo: null,
        references: [],
        location: location(2),
      }],
      authoritative: false,
    });
    const response = await createApi(service).request(`/api/conversations/${child!.conversationId}`);
    const conversation = canonicalConversationSchema.parse(await response.json());
    const persistedChild = conversation.messages.find(({ id }) => id === child!.id);

    expect(response.status).toBe(200);
    expect(lateParent!.conversationId).toBe(child!.conversationId);
    expect(conversation.id).toBe(child!.conversationId);
    expect(conversation.messages.map(({ messageId }) => messageId)).toEqual([
      lateParentMessageId,
      "<large-child@example.test>",
    ]);
    expect(persistedChild?.references).toHaveLength(referenceCount);
    expect(persistedChild?.references).toEqual(references);
    store.close();
  });

  test("keeps a late-arriving References ancestry ordered under the original conversation identity", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const location = (uid: number) => ({
      accountId: account.id, provider: "imap" as const, mailbox: "INBOX", uidValidity: "late-ancestry", uid,
      modseq: null, providerId: null, read: false, flagged: false,
    });
    const reconcile = async (uid: number, messageId: string, references: readonly string[], receivedAt: string) => {
      const [message] = await store.reconcileMailbox({
        tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "INBOX",
        authoritative: false,
        observations: [{ tenantId: "test-tenant", messageId, inReplyTo: null, references: [...references],
          receivedAt, location: location(uid) }],
      });
      return message!;
    };

    const child = await reconcile(1, "<child@example.test>", [
      "<root@example.test>", "<missing@example.test>", "<parent@example.test>",
    ], "2026-09-01T00:00:00.000Z");
    const parent = await reconcile(2, "<parent@example.test>", [], "2026-09-02T00:00:00.000Z");
    const root = await reconcile(3, "<root@example.test>", [], "2026-09-03T00:00:00.000Z");
    const response = await createApi(service).request(`/api/conversations/${child.conversationId}`);
    const conversation = canonicalConversationSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(parent.conversationId).toBe(child.conversationId);
    expect(root.conversationId).toBe(child.conversationId);
    expect(conversation.id).toBe(child.conversationId);
    expect(conversation.messages.map(({ messageId }) => messageId)).toEqual([
      "<root@example.test>", "<parent@example.test>", "<child@example.test>",
    ]);
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
