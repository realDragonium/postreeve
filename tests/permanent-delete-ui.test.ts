import { describe, expect, test } from "bun:test";
import type { Folder } from "../src/shared/contracts";
import { canDeletePermanently, emptyLabel, messageCount, purgeableFolder } from "../src/web/permanent-delete";

const folders: Folder[] = [
  { path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 0, total: 3 },
  { path: "Bin", name: "Bin", specialUse: "trash", unread: 0, total: 2 },
  { path: "Junk", name: "Junk", specialUse: "junk", unread: 0, total: 1 },
  { path: "Old", name: "Old", specialUse: null, unread: 0, total: 9 },
];

describe("permanent delete UI rules", () => {
  test("offers it only in Trash and Spam", () => {
    expect(purgeableFolder(folders, "Bin")?.specialUse).toBe("trash");
    expect(purgeableFolder(folders, "Junk")?.specialUse).toBe("junk");
    expect(purgeableFolder(folders, "INBOX")).toBeNull();
    expect(purgeableFolder(folders, "Old")).toBeNull();
    expect(purgeableFolder(folders, "Missing")).toBeNull();
  });

  test("offers it only for IMAP accounts", () => {
    expect(canDeletePermanently({ kind: "imap" })).toBe(true);
    expect(canDeletePermanently({ kind: "gmail" })).toBe(false);
    expect(canDeletePermanently(undefined)).toBe(false);
  });

  test("labels", () => {
    expect(emptyLabel("trash")).toBe("Empty Trash");
    expect(emptyLabel("junk")).toBe("Empty Spam");
    expect(messageCount(1)).toBe("1 message");
    expect(messageCount(3)).toBe("3 messages");
  });
});
