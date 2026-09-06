import { afterAll, expect, spyOn, test } from "bun:test";
import { ApiRequestError, api } from "../src/web/api";

const fetchSpy = spyOn(globalThis, "fetch");

afterAll(() => fetchSpy.mockRestore());

test("web API reads and validates a canonical conversation aggregate", async () => {
  const requested: string[] = [];
  fetchSpy.mockImplementation(Object.assign(async (input: string | URL | Request) => {
    requested.push(String(input));
    return Response.json({
      id: "conversation/one",
      aliases: ["old-conversation"],
      tenantId: "tenant-a",
      messages: [{
        id: "message-1", aliases: [], conversationId: "conversation/one", tenantId: "tenant-a",
        messageId: "<message@example.test>", inReplyTo: null, references: [], receivedAt: null,
        createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
      }],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  }, { preconnect: globalThis.fetch.preconnect }));

  const conversation = await api.conversation("conversation/one");
  expect(requested).toEqual(["/api/conversations/conversation%2Fone"]);
  expect(conversation.messages[0]?.receivedAt).toBeNull();
});

test("web API sends typed draft lifecycle requests", async () => {
  const requested: Array<{ url: string; method: string; body: unknown }> = [];
  const now = "2026-09-06T10:00:00.000Z";
  const content = {
    mode: "new" as const,
    to: [{ name: "Recipient", address: "recipient@example.test" }],
    cc: [],
    bcc: [],
    subject: "Typed draft",
    body: "Draft body",
    identity: { name: "Person", address: "person@example.test" },
  };
  const draft = {
    id: "draft/one",
    accountId: "account/one",
    ...content,
    delivery: { status: "editable" as const },
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const receipt = {
    id: "receipt-1",
    accountId: draft.accountId,
    messageId: "<message@example.test>",
    accepted: ["recipient@example.test"],
    rejected: [],
    submittedAt: now,
  };
  fetchSpy.mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    requested.push({ url: String(input), method: init?.method ?? "GET", body });
    if (String(input).endsWith("/send")) return Response.json(receipt);
    if (init?.method === "DELETE") return Response.json({ ok: true });
    return Response.json(draft);
  }, { preconnect: globalThis.fetch.preconnect }));

  expect(await api.createDraft({ accountId: draft.accountId, ...content })).toEqual(draft);
  expect(await api.updateDraft(draft.accountId, draft.id, { ...content, version: 1 })).toEqual(draft);
  expect(await api.removeDraft(draft.accountId, draft.id, { version: 1 })).toEqual({ ok: true });
  expect(await api.copyDraft(draft.accountId, draft.id, { version: 1 })).toEqual(draft);
  expect(await api.sendDraft(draft.accountId, draft.id, { version: 1 })).toEqual(receipt);
  expect(requested).toEqual([
    { url: "/api/accounts/account%2Fone/drafts", method: "POST", body: content },
    { url: "/api/accounts/account%2Fone/drafts/draft%2Fone", method: "PUT", body: { ...content, version: 1 } },
    { url: "/api/accounts/account%2Fone/drafts/draft%2Fone", method: "DELETE", body: { version: 1 } },
    { url: "/api/accounts/account%2Fone/drafts/draft%2Fone/copy", method: "POST", body: { version: 1 } },
    { url: "/api/accounts/account%2Fone/drafts/draft%2Fone/send", method: "POST", body: { version: 1 } },
  ]);
});

test("web API preserves typed draft error codes and HTTP status", async () => {
  fetchSpy.mockImplementation(Object.assign(async (input: string | URL | Request) => {
    if (String(input).includes("missing")) {
      return Response.json({ error: "Draft not found", code: "draft_not_found" }, { status: 404 });
    }
    return Response.json({ error: "Draft version conflict", code: "draft_conflict" }, { status: 409 });
  }, { preconnect: globalThis.fetch.preconnect }));

  const conflict = await api.updateDraft("account", "conflict", {
    mode: "new",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    identity: { name: "Person", address: "person@example.test" },
    version: 1,
  }).catch((error: unknown) => error);
  expect(conflict).toBeInstanceOf(ApiRequestError);
  if (!(conflict instanceof ApiRequestError)) throw new Error("Expected ApiRequestError");
  expect(conflict.code).toBe("draft_conflict");
  expect(conflict.status).toBe(409);

  const missing = await api.draft("account", "missing").catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(ApiRequestError);
  if (!(missing instanceof ApiRequestError)) throw new Error("Expected ApiRequestError");
  expect(missing.code).toBe("draft_not_found");
  expect(missing.status).toBe(404);
});
