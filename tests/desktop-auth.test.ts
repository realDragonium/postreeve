import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { desktopApiAuthentication } from "../src/server/security/desktop-auth";

function authenticatedApp(token?: string): Hono {
  const app = new Hono();
  app.use("/api/*", desktopApiAuthentication(token));
  app.get("/api/health", (context) => context.json({ ok: true }));
  app.get("/api/oauth/google/callback", (context) => context.text("callback"));
  return app;
}

describe("Electron backend authentication", () => {
  test("leaves the standalone web server unchanged when no token is configured", async () => {
    expect((await authenticatedApp().request("/api/health")).status).toBe(200);
  });

  test("requires the exact bearer token for desktop API requests", async () => {
    const app = authenticatedApp("launch-secret");

    expect((await app.request("/api/health")).status).toBe(401);
    expect((await app.request("/api/health", {
      headers: { Authorization: "Bearer wrong-secret" },
    })).status).toBe(401);
    expect((await app.request("/api/health", {
      headers: { Authorization: "Bearer launch-secret" },
    })).status).toBe(200);
  });

  test("allows the state-protected Google callback without a desktop header", async () => {
    const app = authenticatedApp("launch-secret");
    expect((await app.request("/api/oauth/google/callback?code=test&state=test")).status).toBe(200);
  });
});
