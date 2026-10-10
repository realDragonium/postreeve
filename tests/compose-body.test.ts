import { describe, expect, test } from "bun:test";
import { escapeHtml, swapPlainSignature, textToHtml } from "../src/web/compose-body";

describe("compose body helpers", () => {
  test("converts text to escaped HTML lines", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(textToHtml("Hi <you>\n\nBye")).toBe("<div>Hi &lt;you&gt;</div><div><br></div><div>Bye</div>");
  });

  test("inserts a plain signature before the quote or at the end", () => {
    const quote = "\n\nOn Monday, Sam wrote:\n> Hello";
    expect(swapPlainSignature(quote, "", "Alex")).toBe(`${quote}\n\n-- \nAlex`);
    expect(swapPlainSignature(quote, "", "Alex", quote)).toBe(`\n\n-- \nAlex${quote}`);
    expect(swapPlainSignature("Typed", "", "")).toBe("Typed");
  });

  test("swaps or removes an unchanged signature without touching typed text", () => {
    const body = "Typed text\n\n-- \nAlex\nPrimary\n\nOn Monday, Sam wrote:\n> Hi";
    expect(swapPlainSignature(body, "Alex\nPrimary", "Sales team")).toBe("Typed text\n\n-- \nSales team\n\nOn Monday, Sam wrote:\n> Hi");
    expect(swapPlainSignature(body, "Alex\nPrimary", "")).toBe("Typed text\n\nOn Monday, Sam wrote:\n> Hi");
  });

  test("leaves an edited signature alone", () => {
    expect(swapPlainSignature("Typed\n\n-- \nAlex (edited)", "Alex\nPrimary", "Sales")).toBeNull();
    expect(swapPlainSignature("Typed\n\n-- \nHand-written", "", "Sales")).toBeNull();
    expect(swapPlainSignature("Typed\n\n-- \nAlex (edited)", "Alex", "Sales")).toBeNull();
  });
});
