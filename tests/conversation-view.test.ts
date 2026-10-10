import { describe, expect, test } from "bun:test";
import type { MessageSummary } from "../src/shared/contracts";
import { conversationThread, initiallyExpanded } from "../src/web/conversation-view";

function message(canonicalId: string, mailbox: string, read = true): MessageSummary {
  return {
    canonicalId,
    ref: { accountId: "a", mailbox, uidValidity: "1", uid: 1, modseq: null },
    messageId: `<${canonicalId}@example.test>`,
    subject: "Plans",
    from: [{ name: "Sam", address: "sam@example.test" }],
    to: [],
    receivedAt: "2026-09-01T00:00:00.000Z",
    preview: "",
    read,
    flagged: false,
  };
}

describe("conversation thread", () => {
  const opened = message("second", "INBOX");
  const members = [message("first", "Archive"), message("second", "All Mail"), message("reply", "Sent", false)];

  test("keeps conversation order with the opened list row in its own place", () => {
    const thread = conversationThread(opened, members);
    expect(thread.map(({ canonicalId, ref }) => [canonicalId, ref.mailbox])).toEqual([
      ["first", "Archive"], ["second", "INBOX"], ["reply", "Sent"],
    ]);
  });

  test("falls back to the opened message alone", () => {
    expect(conversationThread(opened, undefined)).toEqual([opened]);
    expect(conversationThread(opened, [message("first", "Archive")])).toEqual([opened]);
  });

  test("expands the opened message and unread messages only", () => {
    expect([...initiallyExpanded(conversationThread(opened, members), opened)]).toEqual(["second", "reply"]);
  });
});
