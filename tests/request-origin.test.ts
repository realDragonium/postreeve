import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { allowedHostGuard, sameOriginGuard } from "../src/server/security/request-origin";

function guardedApp(configuredHost = "127.0.0.1"): Hono {
  const app = new Hono();
  app.use("*", allowedHostGuard(configuredHost));
  app.use("/api/*", sameOriginGuard());
  app.get("/api/health", (context) => context.json({ ok: true }));
  app.post("/api/messages/send", (context) => context.json({ ok: true }));
  return app;
}

async function status(app: Hono, headers: Record<string, string>, method = "GET"): Promise<number> {
  const path = method === "GET" ? "/api/health" : "/api/messages/send";
  return (await app.request(path, { method, headers })).status;
}

describe("allowed host guard", () => {
  test("accepts loopback names on any port", async () => {
    const app = guardedApp();
    for (const host of ["127.0.0.1:3000", "localhost:4187", "LOCALHOST", "[::1]:3000"]) {
      expect(await status(app, { Host: host })).toBe(200);
    }
  });

  test("rejects rebound, malformed and missing hosts", async () => {
    const app = guardedApp();
    const response = await app.request("/api/health", { headers: { Host: "attacker.example:3000" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden host" });
    expect(await status(app, { Host: "127.0.0.1.attacker.example" })).toBe(403);
    expect(await status(app, { Host: "bad host" })).toBe(403);
    expect(await status(app, {})).toBe(403);
  });

  test("adds a deliberately configured host but not a wildcard bind", async () => {
    expect(await status(guardedApp("192.168.1.10"), { Host: "192.168.1.10:3000" })).toBe(200);
    expect(await status(guardedApp("Mail.Lan"), { Host: "mail.lan:3000" })).toBe(200);
    expect(await status(guardedApp("::1"), { Host: "[::1]:3000" })).toBe(200);
    const wildcard = guardedApp("0.0.0.0");
    expect(await status(wildcard, { Host: "127.0.0.1:3000" })).toBe(200);
    expect(await status(wildcard, { Host: "0.0.0.0:3000" })).toBe(403);
    expect(await status(guardedApp("::"), { Host: "[::]:3000" })).toBe(403);
  });
});

describe("same-origin guard", () => {
  test("allows same-origin and Origin-less state changes", async () => {
    const app = guardedApp();
    expect(await status(app, { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" }, "POST")).toBe(200);
    expect(await status(app, { Host: "127.0.0.1:4187", Origin: "http://127.0.0.1:4187" }, "POST")).toBe(200);
    expect(await status(app, { Host: "127.0.0.1:3000" }, "POST")).toBe(200);
  });

  test("rejects cross-site state changes", async () => {
    const app = guardedApp();
    const response = await app.request("/api/messages/send", {
      method: "POST",
      headers: { Host: "localhost:3000", Origin: "http://localhost:8080" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden origin" });
    expect(await status(app, { Host: "127.0.0.1:3000", Origin: "null" }, "POST")).toBe(403);
    expect(await status(app, { Host: "127.0.0.1:3000", Origin: "https://127.0.0.1:3000" }, "POST")).toBe(403);
  });

  test("leaves reads to the browser's same-origin policy", async () => {
    expect(await status(guardedApp(), { Host: "127.0.0.1:3000", Origin: "http://localhost:8080" })).toBe(200);
  });
});
