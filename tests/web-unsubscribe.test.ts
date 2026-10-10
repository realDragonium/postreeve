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

  test("uses email before a plain link and shows exactly what will be sent", () => {
    expect(unsubscribePlan({ https, mailto, oneClick: false })?.confirmation).toBe(
      "Unsubscribe by email? Postreeve will send this message to leave@example.test from the address this message was delivered to.\n\nSubject: stop\n\nunsubscribe",
    );
  });

  test("skips an email it could not send", () => {
    expect(unsubscribePlan({ https, mailto: `mailto:leave@example.test?body=${"x".repeat(501)}`, oneClick: false })?.kind).toBe("link");
  });

  test("falls back to opening the link", () => {
    expect(unsubscribePlan({ https, mailto: null, oneClick: false })).toMatchObject({ kind: "link", url: https });
  });
});
