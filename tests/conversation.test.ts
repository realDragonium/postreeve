import { describe, expect, test } from "bun:test";
import {
  mergeThreadingMetadata,
  orderConversationMessages,
  type ConversationMessageForOrder,
} from "../src/server/mail/conversation";

describe("conversation resolution", () => {
  test("merges conflicting threading metadata independently of observation order", () => {
    const observations = [
      { inReplyTo: "<parent-b@example.test>", references: ["<root@example.test>", "<parent-b@example.test>"] },
      { inReplyTo: "<parent-a@example.test>", references: ["<root@example.test>", "<parent-a@example.test>"] },
    ];
    const resolve = (values: typeof observations) => {
      let retained: { inReplyTo: string | null; references: string[]; edges: string[] } = {
        inReplyTo: null, references: [], edges: [],
      };
      for (const observed of values) {
        retained = mergeThreadingMetadata(observed.inReplyTo, observed.references, retained, []);
      }
      return retained;
    };

    const forward = resolve(observations);
    const reverse = resolve([...observations].reverse());
    expect(forward).toEqual(reverse);
    expect(forward.inReplyTo).toBe("<parent-a@example.test> <parent-b@example.test>");
    expect(forward.edges).toEqual([
      "<parent-a@example.test>", "<parent-b@example.test>", "<root@example.test>",
    ]);
  });

  test("orders causally, then chronologically with null timestamps last", () => {
    const message = (
      id: string,
      receivedAt: string | null,
      inReplyTo: string | null = null,
    ): ConversationMessageForOrder => ({
      id, identityKey: `message-id:<${id}@example.test>`, messageId: `<${id}@example.test>`,
      inReplyTo, references: inReplyTo ? [inReplyTo] : [], receivedAt,
    });
    const ordered = orderConversationMessages([
      message("later-root", "2026-09-03T00:00:00.000Z"),
      message("child", "2026-09-01T00:00:00.000Z", "<later-root@example.test>"),
      message("earlier-root", "2026-09-02T00:00:00.000Z"),
      message("missing-date", null),
    ]);
    expect(ordered.map(({ id }) => id)).toEqual(["earlier-root", "later-root", "child", "missing-date"]);
  });

  test("orders every direct parent before a multi-parent reply without ordering the parents artificially", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "reply", identityKey: "reply", messageId: "<reply@example.test>",
        inReplyTo: "<later@example.test> <earlier@example.test>", references: [],
        receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "later", identityKey: "later", messageId: "<later@example.test>", inReplyTo: null, references: [],
        receivedAt: "2026-09-03T00:00:00.000Z" },
      { id: "earlier", identityKey: "earlier", messageId: "<earlier@example.test>", inReplyTo: null, references: [],
        receivedAt: "2026-09-02T00:00:00.000Z" },
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["earlier", "later", "reply"]);
  });

  test("keeps descendants after a cyclic parent component", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "child", identityKey: "a", messageId: "<child@example.test>", inReplyTo: "<cycle-a@example.test>", references: [], receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "cycle-a", identityKey: "b", messageId: "<cycle-a@example.test>", inReplyTo: "<cycle-b@example.test>", references: [], receivedAt: "2026-09-03T00:00:00.000Z" },
      { id: "cycle-b", identityKey: "c", messageId: "<cycle-b@example.test>", inReplyTo: "<cycle-a@example.test>", references: [], receivedAt: "2026-09-02T00:00:00.000Z" },
    ];
    expect(orderConversationMessages(messages).map(({ id }) => id))
      .toEqual(["cycle-b", "cycle-a", "child"]);
  });
});
