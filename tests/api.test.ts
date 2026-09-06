import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hc } from "hono/client";
import {
  accountSchema,
  canonicalMessageDetailSchema,
  canonicalMessageSummarySchema,
  canonicalConversationSchema,
  draftSchema,
  folderSchema,
  messageSummarySchema,
  proposalSchema,
  sendReceiptSchema,
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

  test("materializes a wide aliased conversation with bounded retrieval queries", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const location = (mailbox: string, uid: number) => ({
      accountId: account.id, provider: "imap" as const, mailbox, uidValidity: "wide-conversation", uid,
      modseq: null, providerId: null, read: false, flagged: false,
    });
    const [root] = await store.reconcileMailbox({
      tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{ tenantId: "test-tenant", messageId: "<wide-root@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-02T00:00:00.000Z", location: location("INBOX", 1) }],
    });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "Archive", authoritative: false,
      observations: [{ tenantId: "test-tenant", messageId: null, inReplyTo: null, references: [],
        receivedAt: null, location: location("Archive", 2) }],
    });
    expect(await store.recordProviderMove("test-tenant", "imap", {
      accountId: account.id, mailbox: "INBOX", uidValidity: "wide-conversation", uid: 1, modseq: null,
    }, {
      accountId: account.id, mailbox: "Archive", uidValidity: "wide-conversation", uid: 2, modseq: null,
    })).toBe(true);

    const childCount = 256;
    const childIds = Array.from({ length: childCount }, (_, index) =>
      `wide-child-${index.toString().padStart(4, "0")}`);
    await store.reconcileMailbox({
      tenantId: "test-tenant", accountId: account.id, provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: childIds.map((id, index) => ({
        tenantId: "test-tenant", messageId: `<${id}@example.test>`, inReplyTo: "<wide-root@example.test>",
        references: ["<wide-root@example.test>"], receivedAt: "2026-09-01T00:00:00.000Z",
        location: location("INBOX", index + 3),
      })),
    });

    const querySpy = spyOn(Database.prototype, "query");
    let response: Response;
    let retrievalQueryCount = 0;
    try {
      response = await createApi(service).request(`/api/conversations/${fallback!.conversationId}`);
    } finally {
      retrievalQueryCount = querySpy.mock.calls.length;
      querySpy.mockRestore();
    }
    const conversation = canonicalConversationSchema.parse(await response.json());

    expect(retrievalQueryCount).toBe(5);
    expect(conversation.id).toBe(root!.conversationId);
    expect(conversation.messages.map(({ messageId }) => messageId)).toEqual([
      "<wide-root@example.test>", ...childIds.map((id) => `<${id}@example.test>`),
    ]);
    expect(conversation.messages[0]).toMatchObject({
      id: root!.id,
      aliases: [fallback!.id],
      conversationId: root!.conversationId,
      inReplyTo: null,
      references: [],
      receivedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(conversation.messages[1]).toMatchObject({
      inReplyTo: "<wide-root@example.test>",
      references: ["<wide-root@example.test>"],
      receivedAt: "2026-09-01T00:00:00.000Z",
    });
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

  test("exposes account-scoped draft lifecycle and send routes through the typed client", async () => {
    const { store, service, sent } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const other = await service.createAccount(testAccountInput("Other", "other@example.test"));
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const content = {
      mode: "new" as const,
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Typed server draft",
      body: "Draft body",
      identity: { name: account.name, address: account.email },
    };

    const createdResponse = await client.api.accounts[":accountId"].drafts.$post({
      param: { accountId: account.id },
      json: content,
    });
    expect(createdResponse.status).toBe(201);
    const created = draftSchema.parse(await createdResponse.json());
    const listResponse = await client.api.accounts[":accountId"].drafts.$get({
      param: { accountId: account.id },
    });
    expect(draftSchema.array().parse(await listResponse.json())).toEqual([created]);
    const hiddenResponse = await client.api.accounts[":accountId"].drafts[":draftId"].$get({
      param: { accountId: other.id, draftId: created.id },
    });
    expect(hiddenResponse.status).toBe(404);

    const updatedResponse = await client.api.accounts[":accountId"].drafts[":draftId"].$put({
      param: { accountId: account.id, draftId: created.id },
      json: { ...content, subject: "Updated", version: created.version },
    });
    const updated = draftSchema.parse(await updatedResponse.json());
    const staleResponse = await client.api.accounts[":accountId"].drafts[":draftId"].$put({
      param: { accountId: account.id, draftId: created.id },
      json: { ...content, subject: "Stale", version: created.version },
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ code: "draft_conflict" });

    const sentResponse = await client.api.accounts[":accountId"].drafts[":draftId"].send.$post({
      param: { accountId: account.id, draftId: created.id },
      json: { version: updated.version },
    });
    expect(sentResponse.status).toBe(200);
    expect(sent).toHaveLength(1);
    const replayResponse = await client.api.accounts[":accountId"].drafts[":draftId"].send.$post({
      param: { accountId: account.id, draftId: created.id },
      json: { version: updated.version },
    });
    expect(sendReceiptSchema.parse(await replayResponse.json()))
      .toEqual(sendReceiptSchema.parse(await sentResponse.clone().json()));
    store.close();
  });

  test("creates, reads, and updates arbitrary raw recipient text through typed routes", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const healthy = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [{ name: "Complete", address: "complete@example.test" }],
      cc: [],
      bcc: [],
      subject: "Healthy sibling",
      body: "Structured recipients remain supported.",
      identity: { name: account.name, address: account.email },
      attachments: [],
    });
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const raw = {
      mode: "new" as const,
      to: "  alice@ ; Bob <bob@example.test>  ",
      cc: "carol@example.test,   dave@",
      bcc: "  undisclosed; pending@  ",
      subject: "Raw recipients",
      body: "Preserve unfinished input.",
      identity: { name: account.name, address: account.email },
      attachments: [],
    };

    const createdResponse = await client.api.accounts[":accountId"].drafts.$post({
      param: { accountId: account.id },
      json: raw,
    });
    expect(createdResponse.status).toBe(201);
    const created = draftSchema.parse(await createdResponse.json());
    expect(created).toMatchObject(raw);
    const readResponse = await client.api.accounts[":accountId"].drafts[":draftId"].$get({
      param: { accountId: account.id, draftId: created.id },
    });
    expect(draftSchema.parse(await readResponse.json())).toEqual(created);

    const updatedRaw = {
      ...raw,
      to: "alice@example.test, bob@",
      cc: "\tcarol@\n",
      bcc: "one@example.test; two@",
      body: "Keep this body edit too.",
      version: created.version,
    };
    const updateResponse = await client.api.accounts[":accountId"].drafts[":draftId"].$put({
      param: { accountId: account.id, draftId: created.id },
      json: updatedRaw,
    });
    const updated = draftSchema.parse(await updateResponse.json());
    const { version: _version, ...updatedContent } = updatedRaw;
    expect(updated).toMatchObject(updatedContent);
    expect(updated.version).toBe(created.version + 1);
    const listResponse = await client.api.accounts[":accountId"].drafts.$get({
      param: { accountId: account.id },
    });
    expect(draftSchema.array().parse(await listResponse.json()).map(({ id }) => id).sort())
      .toEqual([healthy.id, updated.id].sort());
    store.close();
  });

  test("returns a typed conflict when account removal meets an active draft send", async () => {
    let releaseSend: () => void = () => {};
    let markAttempted: () => void = () => {};
    const sendWait = new Promise<void>((resolve) => { releaseSend = resolve; });
    const attempted = new Promise<void>((resolve) => { markAttempted = resolve; });
    const { store, service } = await createEmptyTestHarness({ sendWait, onSendAttempt: markAttempted });
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Active delivery",
      body: "Keep this draft until delivery settles.",
      identity: { name: account.name, address: account.email },
      attachments: [],
    });
    const sending = service.sendDraft(account.id, draft.id, { version: draft.version });
    await attempted;
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });

    const response = await client.api.accounts[":accountId"].$delete({ param: { accountId: account.id } });
    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Account has a draft delivery in progress",
      code: "account_conflict",
    });

    releaseSend();
    await sending;
    store.close();
  });

  test("copies an uncertain draft through the typed recovery route without dispatching", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness({
      sendFailure: new Error("provider outcome unknown"),
    });
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Recover me",
      body: "Preserve this content",
      identity: { name: account.name, address: account.email },
      attachments: [],
    });
    await expect(service.sendDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("provider outcome unknown");
    const uncertain = await service.getDraft(account.id, draft.id);
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });

    const response = await client.api.accounts[":accountId"].drafts[":draftId"].copy.$post({
      param: { accountId: account.id, draftId: draft.id },
      json: { version: uncertain.version },
    });
    expect(response.status).toBe(201);
    expect(draftSchema.parse(await response.json())).toMatchObject({
      accountId: account.id,
      subject: draft.subject,
      body: draft.body,
      delivery: { status: "editable" },
      version: 1,
    });
    expect(sendAttempts).toHaveLength(1);
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
