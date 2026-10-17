import { describe, expect, test } from "bun:test";
import { accountMatches, folderMatches, mailboxQuerySchema, parseMailboxQuery, plainSearchText } from "../src/shared/mailbox-query";

describe("parseMailboxQuery", () => {
  test("plain words are case-insensitive literal terms", () => {
    expect(parseMailboxQuery("Quarterly PLANNING").terms).toEqual([
      { field: "any", value: "quarterly", negated: false },
      { field: "any", value: "planning", negated: false },
    ]);
  });

  test("field operators, quoted phrases and negation", () => {
    const parsed = parseMailboxQuery(`from:alex to:sam@example.test cc:kim subject:"board meeting" "exact phrase" -newsletter -from:noreply`);
    expect(parsed.terms).toEqual([
      { field: "from", value: "alex", negated: false },
      { field: "to", value: "sam@example.test", negated: false },
      { field: "cc", value: "kim", negated: false },
      { field: "subject", value: "board meeting", negated: false },
      { field: "any", value: "exact phrase", negated: false },
      { field: "any", value: "newsletter", negated: true },
      { field: "from", value: "noreply", negated: true },
    ]);
  });

  test("a quoted operator and unknown operators stay literal", () => {
    expect(parseMailboxQuery(`"from:alex" re: https://example.test/a`).terms).toEqual([
      { field: "any", value: "from:alex", negated: false },
      { field: "any", value: "re:", negated: false },
      { field: "any", value: "https://example.test/a", negated: false },
    ]);
    expect(parseMailboxQuery(`-"two words"`).terms).toEqual([{ field: "any", value: "two words", negated: true }]);
  });

  test("state, attachment and date operators", () => {
    expect(parseMailboxQuery("is:unread is:flagged has:attachment after:2026-01-01 before:2026/02/01")).toMatchObject({
      unread: true, flagged: true, attachment: true,
      after: "2026-01-01T00:00:00.000Z", before: "2026-02-01T00:00:00.000Z", terms: [], errors: [],
    });
    expect(parseMailboxQuery("is:read -is:starred -has:attachment")).toMatchObject({ unread: false, flagged: false, attachment: false });
    expect(parseMailboxQuery("-is:unread").unread).toBe(false);
    expect(parseMailboxQuery("-before:2026-03-01")).toMatchObject({ after: "2026-03-01T00:00:00.000Z" });
  });

  test("invalid dates are reported instead of silently ignored", () => {
    expect(parseMailboxQuery("before:2026-02-30").errors).toEqual(["before: needs a date such as 2026-01-31"]);
    expect(parseMailboxQuery("after:yesterday").errors).toHaveLength(1);
  });

  test("folder, account and anywhere scopes", () => {
    const parsed = parseMailboxQuery("in:sent -in:trash account:work@example.test in:anywhere");
    expect(parsed.folders).toEqual([{ value: "sent", negated: false }, { value: "trash", negated: true }]);
    expect(parsed.accounts).toEqual([{ value: "work@example.test", negated: false }]);
    expect(parsed.anywhere).toBe(true);
  });

  test("plain search text keeps only positive free text for provider fallback", () => {
    expect(plainSearchText(parseMailboxQuery(`invoice from:alex -draft "due date" is:unread`))).toBe("invoice due date");
  });
});

describe("folder and account matching", () => {
  test.each([
    ["sent", "SENT", true], ["sent", "[Gmail]/Sent Mail", true], ["sent", "INBOX.Sent", true], ["sent", "Sent Items", true],
    ["spam", "Junk", true], ["junk", "SPAM", true], ["archive", "__archive__", true], ["inbox", "INBOX", true],
    ["clients", "Projects/Clients", true], ["projects/clients", "Projects/Clients", true], ["sent", "Consent", false], ["inbox", "INBOX.Sent", false],
  ])("in:%s against %s", (value, mailbox, expected) => expect(folderMatches(value, mailbox)).toBe(expected));

  test("account matches address, name or part of either", () => {
    const account = { id: "acct-1", email: "Work@Example.test", name: "Day job" };
    expect(accountMatches("work@example.test", account)).toBe(true);
    expect(accountMatches("example.test", account)).toBe(true);
    expect(accountMatches("day job", account)).toBe(true);
    expect(accountMatches("acct-1", account)).toBe(true);
    expect(accountMatches("personal", account)).toBe(false);
  });
});

describe("mailboxQuerySchema", () => {
  test("requires sources unless the scope is everywhere", () => {
    expect(mailboxQuerySchema.safeParse({ sources: [] }).success).toBe(false);
    expect(mailboxQuerySchema.parse({ scope: "everywhere", query: "invoice" })).toMatchObject({ sources: [], scope: "everywhere", group: "none" });
  });
});
