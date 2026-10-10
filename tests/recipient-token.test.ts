import { describe, expect, test } from "bun:test";
import { acceptRecipient, currentRecipientToken, initialSuggestion } from "../src/web/recipient-token";

describe("recipient token completion", () => {
  test("completes only the address after the last comma", () => {
    expect(currentRecipientToken("bob@x.test,  al ")).toBe("al");
    expect(currentRecipientToken("al")).toBe("al");
    expect(currentRecipientToken("bob@x.test, ")).toBe("");
    expect(acceptRecipient("bob@x.test, al", "alice@example.test")).toBe("bob@x.test, alice@example.test, ");
    expect(acceptRecipient("al", "alice@example.test")).toBe("alice@example.test, ");
  });

  test("pre-selects only a suggestion that starts with an incomplete token", () => {
    const jordan = { name: "Jordan Smith", address: "jordan@acme.com" };
    expect(initialSuggestion("jo", [jordan])).toBe(0);
    expect(initialSuggestion("JORDAN S", [jordan])).toBe(0);
    expect(initialSuggestion("dan", [jordan])).toBeNull();
    expect(initialSuggestion("dan@acme.com", [jordan])).toBeNull();
    expect(initialSuggestion("jordan@acme.com", [jordan])).toBeNull();
    expect(initialSuggestion("jo", [])).toBeNull();
  });
});
