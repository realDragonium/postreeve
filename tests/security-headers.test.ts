import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { postreeveSecureHeaders } from "../src/server/security/headers";

describe("Postreeve security headers", () => {
  test("permits remote images for email frames while their own policy controls consent", async () => {
    const app = new Hono();
    app.use("*", postreeveSecureHeaders);
    app.get("/", (context) => context.text("ok"));

    const response = await app.request("http://postreeve.local/");
    const policy = response.headers.get("Content-Security-Policy");

    expect(policy).toContain("img-src 'self' data: blob: http: https:");
    expect(policy).toContain("script-src 'self'");
  });
});
