import { describe, expect, test } from "bun:test";
import { acceptRecipient, currentRecipientToken } from "../src/web/recipient-token";

describe("recipient token completion", () => {
  test("completes only the address after the last comma", () => {
    expect(currentRecipientToken("bob@x.test,  al ")).toBe("al");
    expect(currentRecipientToken("al")).toBe("al");
    expect(currentRecipientToken("bob@x.test, ")).toBe("");
    expect(acceptRecipient("bob@x.test, al", "alice@example.test")).toBe("bob@x.test, alice@example.test, ");
    expect(acceptRecipient("al", "alice@example.test")).toBe("alice@example.test, ");
  });
});
