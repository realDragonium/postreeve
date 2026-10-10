import { describe, expect, test } from "bun:test";
import { filterInlineStyle } from "../src/shared/inline-styles";

describe("inline style allowlist", () => {
  test("keeps ordinary formatting", () => {
    expect(filterInlineStyle("color: #333; font-weight: bold; font-family: 'Helvetica Neue', Arial, sans-serif; margin:0 0 0 0.8ex; border-left: 1px solid rgb(204, 204, 204); text-align: center"))
      .toBe("color:#333;font-weight:bold;font-family:'Helvetica Neue', Arial, sans-serif;margin:0 0 0 0.8ex;border-left:1px solid rgb(204, 204, 204);text-align:center");
  });

  test.each([
    `background-image: image-set("https://tracker.example/x.png" 1x)`,
    String.raw`background-image: u\72l(https://tracker.example/x.png)`,
    "background: url(https://tracker.example/x.png)",
    "border: 1px solid url(x.png)",
    String.raw`color: r\65d`,
    "list-style-image: url(https://tracker.example/x.png)",
    "content: url(https://tracker.example/x.png)",
    "border-image: url(https://tracker.example/x.png) 30",
    String.raw`b\61ckground: url(https://tracker.example/x.png)`,
    "color: red /* url(https://tracker.example/x.png) */",
    "position: fixed",
  ])("drops %s", (declaration) => {
    expect(filterInlineStyle(`${declaration}; color: red`)).toBe("color:red");
  });

  test("does not trust inherited object keys as properties", () => {
    expect(filterInlineStyle("constructor: x; __proto__: y")).toBe("");
  });
});
