import { afterEach, expect, spyOn, test } from "bun:test";
import { api } from "../src/web/api";

const fetchSpy = spyOn(globalThis, "fetch");

afterEach(() => fetchSpy.mockRestore());

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
