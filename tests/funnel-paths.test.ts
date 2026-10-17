import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { FUNNEL_PUBLIC_PATHS, FUNNEL_REQUEST_HEADER, funnelPathGuard, isFunnelPublicPath } from "../src/server/runtime/funnel-paths";

const app = new Hono().use("*", funnelPathGuard()).all("*", (context) => context.text(`reached ${context.req.path}`));
const funnel = { [FUNNEL_REQUEST_HEADER]: "?1" };

describe("Funnel public-path allowlist", () => {
  test("names the MCP endpoint and the OAuth endpoints a connector calls, but not the consent page", () => {
    expect([...FUNNEL_PUBLIC_PATHS]).toEqual([
      "/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/oauth/register",
      "/oauth/token",
    ]);
    expect(isFunnelPublicPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isFunnelPublicPath("/oauth/authorize")).toBe(false);
    expect(isFunnelPublicPath("/mcpx")).toBe(false);
    expect(isFunnelPublicPath("/MCP")).toBe(false);
  });

  test("lets Funnel requests reach allowlisted paths", async () => {
    const response = await app.request("/mcp", { method: "POST", headers: funnel });
    expect(await response.text()).toBe("reached /mcp");
    expect((await app.request("/oauth/token", { method: "POST", headers: funnel })).status).toBe(200);
  });

  test("answers 404 to Funnel requests for the UI, the API, the consent page and encoded paths", async () => {
    for (const path of ["/", "/index.html", "/api/health", "/api/accounts", "/oauth/authorize", "/mcp%2F..%2Fapi", "/assets/app.js"]) {
      const response = await app.request(path, { headers: funnel });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  });

  test("leaves tailnet and loopback requests alone", async () => {
    expect(await (await app.request("/api/accounts")).text()).toBe("reached /api/accounts");
    expect((await app.request("/oauth/authorize")).status).toBe(200);
  });
});
