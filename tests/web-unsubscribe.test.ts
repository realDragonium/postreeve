import { describe, expect, test } from "bun:test";
import { unsubscribePlan } from "../src/web/unsubscribe";

describe("unsubscribePlan", () => {
  const https = "https://list.example.test/u?id=1";
  const mailto = "mailto:leave@example.test?subject=stop";

  test("prefers one-click and names the host", () => {
    expect(unsubscribePlan({ https, mailto, oneClick: true })).toEqual({
      kind: "one_click",
      confirmation: "Unsubscribe now? Postreeve will send a one-click unsubscribe request to list.example.test.",
    });
  });

  test("uses email before a plain link", () => {
    expect(unsubscribePlan({ https, mailto, oneClick: false })?.confirmation).toContain("to leave@example.test from");
  });

  test("falls back to opening the link", () => {
    expect(unsubscribePlan({ https, mailto: null, oneClick: false })).toMatchObject({ kind: "link", url: https });
  });
});
