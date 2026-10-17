import { describe, expect, test } from "bun:test";
import { describeOperation, requiredConfirmations, mailServerOperationSchema } from "../src/shared/mail-server";
import { formatBytes, parseAddressList, parseQuotaGib, quotaToGib, sortChecks } from "../src/web/admin/format";

describe("mail server UI helpers", () => {
  test("quota input in GiB round-trips and blank means unlimited", () => {
    expect(parseQuotaGib("")).toBeNull();
    expect(parseQuotaGib("1")).toBe(1073741824);
    expect(parseQuotaGib("2,5")).toBe(2684354560);
    expect(parseQuotaGib("-1")).toBeUndefined();
    expect(parseQuotaGib("lots")).toBeUndefined();
    expect(quotaToGib(1073741824)).toBe("1");
    expect(formatBytes(null)).toBe("unlimited");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MiB");
  });

  test("address lists accept commas, spaces and new lines and reject junk", () => {
    expect(parseAddressList("Alice@example.org, bob@example.org\nalice@example.org")).toEqual(["alice@example.org", "bob@example.org"]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("alice@example.org, not-an-address")).toBeNull();
  });

  test("DNS checks list delivery records first", () => {
    const check = (category: "srv" | "mx" | "dkim" | "spf") => ({ category, name: "", type: "TXT", value: "", status: "ok" as const, found: [], error: null });
    expect(sortChecks([check("srv"), check("dkim"), check("mx"), check("spf")]).map(({ category }) => category)).toEqual(["mx", "spf", "dkim", "srv"]);
  });

  test("proposal operations describe themselves and name what must be typed", () => {
    const operations = [
      { type: "deleteMailbox", address: "Old@example.org" },
      { type: "createMailbox", address: "new@example.org", addToPostreeve: true },
      { type: "deleteDomain", domain: "example.net" },
    ].map((operation) => mailServerOperationSchema.parse(operation));
    expect(requiredConfirmations(operations)).toEqual(["old@example.org", "example.net"]);
    expect(operations.map(describeOperation)).toEqual([
      "Delete mailbox old@example.org",
      "Create mailbox new@example.org and add it to Postreeve",
      "Delete domain example.net",
    ]);
  });
});
