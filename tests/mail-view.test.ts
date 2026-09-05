import { describe, expect, test } from "bun:test";
import type { Folder, MessageSummary } from "../src/shared/contracts";
import {
  countLine,
  filterMessages,
  mergeMessages,
  messageKey,
  scopeSources,
  senderName,
  sortMessages,
  unifiedFolders,
} from "../src/web/mail-view";

function message(overrides: Partial<MessageSummary> & { uid: number; accountId?: string }): MessageSummary {
  const { uid, accountId = "a", ...rest } = overrides;
  return {
    ref: { accountId, mailbox: "INBOX", uidValidity: "1", uid, modseq: null },
    messageId: `m${uid}@example.com`,
    subject: `Subject ${uid}`,
    from: [{ name: `Sender ${uid}`, address: `s${uid}@example.com` }],
    to: [{ name: "Me", address: "me@example.com" }],
    receivedAt: `2026-08-0${uid}T09:00:00.000Z`,
    preview: "",
    read: true,
    flagged: false,
    ...rest,
  };
}

function folder(overrides: Partial<Folder> & { path: string }): Folder {
  return { name: overrides.path, specialUse: null, unread: 0, total: 0, ...overrides };
}

describe("scopeSources", () => {
  const folders = new Map<string, readonly Folder[]>([
    ["a", [folder({ path: "INBOX", specialUse: "inbox" }), folder({ path: "Keep" })]],
    ["b", [folder({ path: "In", specialUse: "inbox" }), folder({ path: "Bin", specialUse: "trash" })]],
  ]);

  test("an account scope reads exactly one mailbox", () => {
    expect(scopeSources({ kind: "account", accountId: "a", path: "Keep" }, folders))
      .toEqual([{ accountId: "a", mailbox: "Keep" }]);
  });

  test("a unified scope fans the special use out across every account that has it", () => {
    expect(scopeSources({ kind: "unified", specialUse: "inbox" }, folders))
      .toEqual([{ accountId: "a", mailbox: "INBOX" }, { accountId: "b", mailbox: "In" }]);
  });

  test("a unified scope no account provides reads nothing", () => {
    expect(scopeSources({ kind: "unified", specialUse: "drafts" }, folders)).toEqual([]);
  });
});

describe("unifiedFolders", () => {
  test("sums counts per special use and keeps Inbox even when empty", () => {
    const rows = unifiedFolders(new Map([
      ["a", [folder({ path: "INBOX", specialUse: "inbox", unread: 2, total: 9 })]],
      ["b", [folder({ path: "In", specialUse: "inbox", unread: 3, total: 4 }), folder({ path: "Bin", specialUse: "trash", total: 1 })]],
    ]));
    expect(rows.map(({ name, unread, total }) => [name, unread, total]))
      .toEqual([["Inbox", 5, 13], ["Trash", 0, 1]]);
  });

  test("drops special uses no account has, apart from Inbox", () => {
    expect(unifiedFolders(new Map()).map(({ name }) => name)).toEqual(["Inbox"]);
  });
});

describe("mergeMessages", () => {
  test("drops a message returned by two overlapping queries", () => {
    const shared = message({ uid: 1 });
    expect(mergeMessages([[shared, message({ uid: 2 })], [shared]]).map(messageKey))
      .toEqual(["a:INBOX:1:1", "a:INBOX:1:2"]);
  });

  test("keeps the same uid from two different accounts apart", () => {
    expect(mergeMessages([[message({ uid: 1, accountId: "a" }), message({ uid: 1, accountId: "b" })]])).toHaveLength(2);
  });

  test("deduplicates one canonical message across accounts and overlapping locations", () => {
    const inbox = message({ uid: 1, accountId: "a", canonicalId: "canonical-1" });
    const overlapping = message({
      uid: 9,
      accountId: "b",
      canonicalId: "canonical-1",
      ref: { accountId: "b", mailbox: "All Mail", uidValidity: "2", uid: 9, modseq: null },
    });

    expect(mergeMessages([[inbox], [overlapping]])).toEqual([inbox]);
  });

  test("keeps client identity stable when a canonical message moves", () => {
    const before = message({ uid: 1, canonicalId: "canonical-1" });
    const after = message({
      uid: 8,
      canonicalId: "canonical-1",
      ref: { accountId: "a", mailbox: "Archive", uidValidity: "2", uid: 8, modseq: null },
    });

    expect(messageKey(after)).toBe(messageKey(before));
  });

  test("falls back to the exact provider location before persistence", () => {
    expect(messageKey(message({ uid: 1 }))).toBe("a:INBOX:1:1");
  });
});

describe("sortMessages", () => {
  const messages = [message({ uid: 1 }), message({ uid: 3 }), message({ uid: 2 })];

  test("newest first is the default order", () => {
    expect(sortMessages(messages, "newest").map((entry) => entry.ref.uid)).toEqual([3, 2, 1]);
  });

  test("oldest first reverses it", () => {
    expect(sortMessages(messages, "oldest").map((entry) => entry.ref.uid)).toEqual([1, 2, 3]);
  });

  test("sender sorts on the display name", () => {
    expect(sortMessages(messages, "sender").map(senderName)).toEqual(["Sender 1", "Sender 2", "Sender 3"]);
  });

  test("sorting does not mutate the input", () => {
    const input = [message({ uid: 1 }), message({ uid: 2 })];
    sortMessages(input, "oldest");
    expect(input.map((entry) => entry.ref.uid)).toEqual([1, 2]);
  });
});

describe("filterMessages", () => {
  const messages = [message({ uid: 1, read: false }), message({ uid: 2, flagged: true }), message({ uid: 3 })];

  test("unread keeps only unread mail", () => {
    expect(filterMessages(messages, "unread").map((entry) => entry.ref.uid)).toEqual([1]);
  });

  test("flagged keeps only flagged mail", () => {
    expect(filterMessages(messages, "flagged").map((entry) => entry.ref.uid)).toEqual([2]);
  });

  test("all keeps everything", () => {
    expect(filterMessages(messages, "all")).toHaveLength(3);
  });
});

describe("countLine", () => {
  test("reports counts, and names the search and filter when they are narrowing the list", () => {
    expect(countLine([message({ uid: 1, read: false })], { query: "invoice", filter: "unread", awaiting: 2 }))
      .toBe("1 message · 1 unread · 2 awaiting you · matching “invoice” · unread only");
  });

  test("stays to plain counts when nothing is narrowing it", () => {
    expect(countLine([message({ uid: 1 }), message({ uid: 2 })], { query: "", filter: "all", awaiting: 0 }))
      .toBe("2 messages · 0 unread");
  });
});
