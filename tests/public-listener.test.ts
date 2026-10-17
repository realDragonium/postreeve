import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { PostreeveService } from "../src/server/core/postreeve";
import { Store } from "../src/server/db/store";
import {
  createPublicApp,
  isPublicPath,
  PUBLIC_PATHS,
  publicListenerFromEnvironment,
  publicPathGuard,
} from "../src/server/runtime/public-listener";

const url = new URL("https://mcp.example.test");
const app = new Hono().use("*", publicPathGuard(url)).all("*", (context) => context.text(`reached ${context.req.path}`));
const host = { Host: "mcp.example.test" };

describe("public listener allowlist", () => {
  test("names the MCP endpoint and the OAuth endpoints a connector calls, but not the consent page", () => {
    expect([...PUBLIC_PATHS]).toEqual([
      "/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/oauth/register",
      "/oauth/token",
      "/oauth/revoke",
    ]);
    expect(isPublicPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isPublicPath("/oauth/authorize")).toBe(false);
    expect(isPublicPath("/mcpx")).toBe(false);
    expect(isPublicPath("/MCP")).toBe(false);
  });

  test("lets allowlisted paths through on the published host", async () => {
    expect(await (await app.request("/mcp", { method: "POST", headers: host })).text()).toBe("reached /mcp");
    expect((await app.request("/oauth/token", { method: "POST", headers: { Host: "MCP.example.test:443" } })).status).toBe(200);
  });

  test("answers a bare 404 for the UI, the API, the consent page and encoded paths", async () => {
    for (const path of ["/", "/index.html", "/api/health", "/api/accounts", "/oauth/authorize", "/mcp%2F..%2Fapi", "/assets/app.js"]) {
      const response = await app.request(path, { headers: host });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  test("answers a bare 404 for any other Host", async () => {
    for (const other of ["127.0.0.1:3001", "postreeve.tailnet.ts.net", "evil.test"]) {
      expect((await app.request("/mcp", { method: "POST", headers: { Host: other } })).status).toBe(404);
    }
    expect((await app.request("/mcp", { method: "POST" })).status).toBe(404);
  });
});

describe("public listener configuration", () => {
  test("is off unless the port is set", () => {
    expect(publicListenerFromEnvironment({})).toBeNull();
    expect(publicListenerFromEnvironment({ POSTREEVE_MCP_PUBLIC_URL: url.href })).toBeNull();
  });

  test("requires a valid port and an https origin", () => {
    expect(publicListenerFromEnvironment({ POSTREEVE_PUBLIC_MCP_PORT: "3001", POSTREEVE_MCP_PUBLIC_URL: "https://mcp.example.test" }))
      .toEqual({ port: 3001, url: new URL("https://mcp.example.test") });
    for (const port of ["0", "70000", "3001.5", "abc"]) {
      expect(() => publicListenerFromEnvironment({ POSTREEVE_PUBLIC_MCP_PORT: port, POSTREEVE_MCP_PUBLIC_URL: url.href })).toThrow();
    }
    for (const value of [undefined, "http://mcp.example.test", "https://mcp.example.test/mcp", "not a url"]) {
      expect(() => publicListenerFromEnvironment({ POSTREEVE_PUBLIC_MCP_PORT: "3001", POSTREEVE_MCP_PUBLIC_URL: value })).toThrow();
    }
  });
});

describe("public app", () => {
  test("serves agent metadata on the published origin and nothing of the UI", async () => {
    const store = new Store(":memory:");
    const publicApp = createPublicApp({ port: 3001, url }, {
      service: {} as PostreeveService, store: store.agentAccess, publicUrl: "https://postreeve.tailnet.ts.net",
    });
    const metadata = await publicApp.request("/.well-known/oauth-authorization-server", { headers: host });
    expect(metadata.status).toBe(200);
    const body = await metadata.json() as { issuer: string; token_endpoint: string; authorization_endpoint: string };
    expect(body.issuer).toBe("https://mcp.example.test");
    expect(body.token_endpoint).toBe("https://mcp.example.test/oauth/token");
    expect(body.authorization_endpoint).toBe("https://postreeve.tailnet.ts.net/oauth/authorize");
    expect(metadata.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect((await publicApp.request("/api/health", { headers: host })).status).toBe(404);
    expect((await publicApp.request("/oauth/authorize", { headers: host })).status).toBe(404);
    store.close();
  });
});
