import { describe, expect, test } from "bun:test";
import {
  mergeThreadingMetadata,
  orderConversationMessages,
  type ConversationMessageForOrder,
  type ThreadingMetadata,
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

  test("does not reuse a deterministic References tie-break as causal evidence", () => {
    const observations = [
      ["<b@example.test>"],
      ["<c@example.test>"],
      ["<c@example.test>", "<a@example.test>", "<b@example.test>"],
    ];
    const permutations = <T>(values: readonly T[]): T[][] => values.length === 0
      ? [[]]
      : values.flatMap((value, index) => permutations(values.filter((_, candidate) => candidate !== index))
        .map((rest) => [value, ...rest]));

    for (const arrivals of permutations(observations)) {
      let retained: ThreadingMetadata = { inReplyTo: null, references: [] };
      for (const references of arrivals) retained = mergeThreadingMetadata(null, references, retained, []);
      expect(retained.references).toEqual([
        "<c@example.test>", "<a@example.test>", "<b@example.test>",
      ]);
    }
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

  test("orders unordered historical parents independently before their child", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "reply", identityKey: "reply", messageId: "<reply@example.test>", inReplyTo: null, references: [],
        threadingEdges: ["<later@example.test>", "<earlier@example.test>"],
        receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "later", identityKey: "later", messageId: "<later@example.test>", inReplyTo: null, references: [],
        receivedAt: "2026-09-03T00:00:00.000Z" },
      { id: "earlier", identityKey: "earlier", messageId: "<earlier@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-02T00:00:00.000Z" },
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["earlier", "later", "reply"]);
  });

  test("uses a descendant's References sequence to order ancestors without their own headers", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "child", identityKey: "child", messageId: "<child@example.test>", inReplyTo: null,
        references: ["<root@example.test>", "<parent@example.test>"],
        receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "parent", identityKey: "parent", messageId: "<parent@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-02T00:00:00.000Z" },
      { id: "root", identityKey: "root", messageId: "<root@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-03T00:00:00.000Z" },
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["root", "parent", "child"]);
  });

  test("preserves known References ancestry across unknown interleaved ancestors for every input permutation", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "child", identityKey: "child", messageId: "<child@example.test>", inReplyTo: null,
        references: ["<root@example.test>", "<missing-a@example.test>", "<parent@example.test>",
          "<missing-b@example.test>"], receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "parent", identityKey: "parent", messageId: "<parent@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-02T00:00:00.000Z" },
      { id: "root", identityKey: "root", messageId: "<root@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-03T00:00:00.000Z" },
    ];
    const permutations = <T>(values: readonly T[]): T[][] => values.length === 0
      ? [[]]
      : values.flatMap((value, index) => permutations(values.filter((_, candidate) => candidate !== index))
        .map((rest) => [value, ...rest]));

    for (const input of permutations(messages)) {
      expect(orderConversationMessages(input).map(({ id }) => id)).toEqual(["root", "parent", "child"]);
    }
  });

  test("joins split References ancestry through a shared unknown identifier for every input permutation", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "unrelated", identityKey: "unrelated", messageId: "<unrelated@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-02T00:00:00.000Z" },
      { id: "root", identityKey: "root", messageId: "<root@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-04T00:00:00.000Z" },
      { id: "parent", identityKey: "parent", messageId: "<parent@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "descendant-a", identityKey: "descendant-a", messageId: "<descendant-a@example.test>",
        inReplyTo: null, references: ["<root@example.test>", "<missing@example.test>"],
        receivedAt: "2026-09-02T00:00:00.000Z" },
      { id: "descendant-b", identityKey: "descendant-b", messageId: "<descendant-b@example.test>",
        inReplyTo: null, references: ["<missing@example.test>", "<parent@example.test>"],
        receivedAt: "2026-09-03T00:00:00.000Z" },
    ];
    const permutations = <T>(values: readonly T[]): T[][] => values.length === 0
      ? [[]]
      : values.flatMap((value, index) => permutations(values.filter((_, candidate) => candidate !== index))
        .map((rest) => [value, ...rest]));

    for (const input of permutations(messages)) {
      const orderedIds = orderConversationMessages(input).map(({ id }) => id);
      expect(orderedIds).toEqual(["unrelated", "root", "parent", "descendant-a", "descendant-b"]);
    }
  });

  test("ignores self references without losing surrounding ancestry", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "child", identityKey: "child", messageId: "<child@example.test>", inReplyTo: null,
        references: ["<root@example.test>", "<child@example.test>", "<parent@example.test>"],
        threadingEdges: ["<child@example.test>"], receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "parent", identityKey: "parent", messageId: "<parent@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-02T00:00:00.000Z" },
      { id: "root", identityKey: "root", messageId: "<root@example.test>", inReplyTo: null,
        references: [], receivedAt: "2026-09-03T00:00:00.000Z" },
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["root", "parent", "child"]);
  });

  test("ignores self-reference per original sequence without bridging separate observations", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "child", identityKey: "child", messageId: "<child@example.test>", inReplyTo: null,
        references: ["<b@example.test>", "<child@example.test>", "<c@example.test>"],
        referenceSequences: [
          ["<b@example.test>", "<child@example.test>"],
          ["<child@example.test>", "<c@example.test>"],
        ],
        threadingEdges: ["<b@example.test>", "<child@example.test>", "<c@example.test>"],
        receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "b", identityKey: "b", messageId: "<b@example.test>", inReplyTo: null, references: [],
        receivedAt: "2026-09-03T00:00:00.000Z" },
      { id: "c", identityKey: "c", messageId: "<c@example.test>", inReplyTo: null, references: [],
        receivedAt: "2026-09-02T00:00:00.000Z" },
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["c", "b", "child"]);
    messages[0] = { ...messages[0]!, referenceSequences: [[
      "<b@example.test>", "<child@example.test>", "<c@example.test>",
    ]] };
    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["b", "c", "child"]);
  });

  test("collapses a References cycle deterministically while keeping its descendant last", () => {
    const messages: ConversationMessageForOrder[] = [
      { id: "child", identityKey: "a", messageId: "<child@example.test>", inReplyTo: null,
        references: ["<cycle-a@example.test>"], receivedAt: "2026-09-01T00:00:00.000Z" },
      { id: "cycle-a", identityKey: "b", messageId: "<cycle-a@example.test>", inReplyTo: null,
        references: ["<cycle-b@example.test>"], receivedAt: "2026-09-03T00:00:00.000Z" },
      { id: "cycle-b", identityKey: "c", messageId: "<cycle-b@example.test>", inReplyTo: null,
        references: ["<cycle-a@example.test>"], receivedAt: "2026-09-02T00:00:00.000Z" },
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id))
      .toEqual(["cycle-b", "cycle-a", "child"]);
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

  test("orders wide fan-out with logarithmic ready-queue comparison growth", () => {
    const childCount = 512;
    let identityKeyReads = 0;
    const message = (id: string, inReplyTo: string | null): ConversationMessageForOrder => ({
      id,
      get identityKey() {
        identityKeyReads += 1;
        return `message-id:<${id}@example.test>`;
      },
      messageId: `<${id}@example.test>`,
      inReplyTo,
      references: [],
      receivedAt: "2026-09-01T00:00:00.000Z",
    });
    const childIds = Array.from({ length: childCount }, (_, index) =>
      `child-${index.toString().padStart(4, "0")}`);
    const messages = [
      message("root", null),
      ...[...childIds].reverse().map((id) => message(id, "<root@example.test>")),
    ];

    expect(orderConversationMessages(messages).map(({ id }) => id)).toEqual(["root", ...childIds]);
    const logarithmicComparisonReadBound = childCount * Math.ceil(Math.log2(childCount + 1)) * 8;
    expect(identityKeyReads).toBeLessThan(logarithmicComparisonReadBound);
  });

  test("merges a long References chain without recursive traversal", () => {
    const references = Array.from({ length: 100_000 }, (_, index) => `<ref-${index}@example.test>`);
    const observed = [...references, references[5_000]!, references[0]!];

    const merged = mergeThreadingMetadata(null, observed, { inReplyTo: null, references: [] }, []);

    expect(merged.references).toEqual(references);
    expect(merged.edges).toHaveLength(references.length);
  });
});
