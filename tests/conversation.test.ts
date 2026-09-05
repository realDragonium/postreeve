import { describe, expect, test } from "bun:test";
import {
  mergeThreadingMetadata,
  orderConversationMessages,
  type ConversationMessageForOrder,
} from "../src/server/mail/conversation";

describe("conversation resolution", () => {
  test("matches the lexicographically first valid order for small acyclic reference observations", () => {
    const ids = ["<a@example.test>", "<b@example.test>", "<c@example.test>"];
    const permutations = <T>(values: readonly T[]): T[][] => values.length === 0
      ? [[]]
      : values.flatMap((value, index) => permutations(values.filter((_, candidate) => candidate !== index))
        .map((rest) => [value, ...rest]));
    const candidateSequences = [
      ...permutations(ids),
      [ids[0]!, ids[1]!, ids[0]!],
      [ids[2]!, ids[0]!, ids[2]!],
    ];

    for (const retained of candidateSequences) {
      for (const observed of candidateSequences) {
        const deduplicated = [retained, observed].map((sequence) => [...new Set(sequence)]);
        const values = [...new Set(deduplicated.flat())];
        const expected = permutations(values)
          .sort((left, right) => left.join("\0").localeCompare(right.join("\0")))
          .find((candidate) => deduplicated.every((sequence) =>
            sequence.every((value, index) => index === 0
              || candidate.indexOf(sequence[index - 1]!) < candidate.indexOf(value))));
        if (!expected) continue;

        expect(mergeThreadingMetadata(null, observed, {
          inReplyTo: null,
          references: retained,
        }, []).references).toEqual(expected);
      }
    }
  });

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

  test("deduplicates each References sequence before retaining first-occurrence order", () => {
    expect(mergeThreadingMetadata(null, [
      "<parent-b@example.test>", "<parent-a@example.test>", "<parent-b@example.test>",
    ], { inReplyTo: null, references: [] }, [])).toMatchObject({
      references: ["<parent-b@example.test>", "<parent-a@example.test>"],
    });
  });

  test("keeps downstream reference precedence after collapsing conflicting cycles", () => {
    const retained = {
      inReplyTo: null,
      references: ["<y@example.test>", "<z@example.test>", "<a@example.test>"],
    };
    const observed = ["<z@example.test>", "<y@example.test>"];
    const expected = ["<y@example.test>", "<z@example.test>", "<a@example.test>"];

    const merged = mergeThreadingMetadata(null, observed, retained, []);
    expect(merged.references).toEqual(expected);
    expect(mergeThreadingMetadata(null, retained.references, {
      inReplyTo: null, references: observed,
    }, []).references).toEqual(expected);
    expect(mergeThreadingMetadata(null, observed, merged, []).references).toEqual(expected);
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

  test("merges a long References chain without recursive traversal", () => {
    const references = Array.from({ length: 10_001 }, (_, index) => `<ref-${index}@example.test>`);
    const observed = [...references, references[5_000]!, references[0]!];

    const merged = mergeThreadingMetadata(null, observed, { inReplyTo: null, references: [] }, []);

    expect(merged.references).toEqual(references);
    expect(merged.edges).toHaveLength(references.length);
  });
});
