import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createServerApp } from "../src/server/app";
import {
  OwnerAuth,
  getOwnerSession,
  ownerAuthContext,
  requireOwner,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from "../src/server/security/owner-auth";
import type { RequestTrust } from "../src/server/security/request-context";
import { createEmptyTestHarness } from "./support/test-mail";

const SETUP_TOKEN = "test-setup-token-0123456789";
const PASSWORD = "correct horse battery";
const LOOPBACK = "127.0.0.1:3000";

interface Fixture {
  readonly app: Hono;
  readonly auth: OwnerAuth;
  readonly clock: { now: number };
}

async function fixture(options: { trust?: RequestTrust; desktopToken?: string; setupToken?: string; eventKeepAliveMs?: number } = {}): Promise<Fixture> {
  const harness = await createEmptyTestHarness();
  const clock = { now: Date.parse("2026-10-01T09:00:00.000Z") };
  const auth = new OwnerAuth({
    store: harness.store.owner,
    trust: options.trust,
    setupToken: options.setupToken ?? SETUP_TOKEN,
    desktopToken: options.desktopToken,
    now: () => new Date(clock.now),
    passwordCost: { memoryCost: 4096, timeCost: 1 },
  });
  const app = createServerApp({
    service: harness.service,
    auth,
    hostname: "127.0.0.1",
    desktopToken: options.desktopToken,
    api: options.eventKeepAliveMs ? { eventKeepAliveMs: options.eventKeepAliveMs } : {},
  });
  return { app, auth, clock };
}

function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { Host: LOOPBACK, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(app: Hono, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers: { Host: LOOPBACK, ...headers } });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const pair = header.split(";")[0] ?? "";
  if (!pair.includes("postreeve-session=")) throw new Error(`No session cookie in ${header}`);
  return pair;
}

async function setUp(app: Hono): Promise<string> {
  const response = await post(app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD });
  expect(response.status).toBe(201);
  return sessionCookie(response);
}

describe("owner setup", () => {
  test("reports setup state and refuses a wrong setup token", async () => {
    const { app, auth } = await fixture();
    expect(await (await get(app, "/api/auth/session")).json()).toEqual({ state: "setup", passkeys: false });
    const response = await post(app, "/api/auth/setup", { setupToken: "guessed-token-guessed", password: PASSWORD });
    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(auth.store.getOwner()).toBeNull();
  });

  test("creates the owner with the token, signs them in and refuses a second setup", async () => {
    const { app, auth } = await fixture();
    const cookie = await setUp(app);
    expect(cookie.startsWith("postreeve-session=")).toBe(true);
    expect(auth.store.getOwner()?.passwordHash.startsWith("$argon2id$")).toBe(true);
    const state = await (await get(app, "/api/auth/session", { Cookie: cookie })).json() as { state: string };
    expect(state.state).toBe("authenticated");
    expect((await post(app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD })).status).toBe(409);
  });

  test("rejects short passwords and short configured tokens", async () => {
    const { app } = await fixture();
    const response = await post(app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: "short" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Password must be at least 12 characters" });
    const harness = await createEmptyTestHarness();
    expect(() => new OwnerAuth({ store: harness.store.owner, setupToken: "too-short" })).toThrow(/at least 16/);
  });

  test("generates a setup token to log only when none is configured and no owner exists", async () => {
    const harness = await createEmptyTestHarness();
    const generated = new OwnerAuth({ store: harness.store.owner, passwordCost: { memoryCost: 4096, timeCost: 1 } });
    const token = generated.setupTokenToLog();
    expect(token?.length).toBeGreaterThanOrEqual(32);
    const app = createServerApp({ service: harness.service, auth: generated, hostname: "127.0.0.1" });
    expect((await post(app, "/api/auth/setup", { setupToken: token, password: PASSWORD })).status).toBe(201);
    expect(generated.setupTokenToLog()).toBeNull();
    const { auth: configured } = await fixture();
    expect(configured.setupTokenToLog()).toBeNull();
  });
});

describe("password sign-in", () => {
  test("signs in with the right password and refuses a wrong one", async () => {
    const { app } = await fixture();
    await setUp(app);
    const wrong = await post(app, "/api/auth/login/password", { password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Incorrect password" });
    const right = await post(app, "/api/auth/login/password", { password: PASSWORD });
    expect(right.status).toBe(200);
    expect((await get(app, "/api/accounts", { Cookie: sessionCookie(right) })).status).toBe(200);
  });

  test("blocks a client after five failures, even with the right password", async () => {
    const { app, clock } = await fixture();
    await setUp(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await post(app, "/api/auth/login/password", { password: "wrong password" })).status).toBe(401);
    }
    const blocked = await post(app, "/api/auth/login/password", { password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    clock.now += 15 * 60 * 1000 + 1;
    expect((await post(app, "/api/auth/login/password", { password: PASSWORD })).status).toBe(200);
  });

  test("caps failures across clients when the proxy is trusted", async () => {
    const { app } = await fixture({ trust: { publicUrl: null, trustProxy: true } });
    await setUp(app);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await post(app, "/api/auth/login/password", { password: "wrong password" }, { "X-Forwarded-For": `198.51.100.7, 203.0.113.${attempt}` });
    }
    const fresh = await post(app, "/api/auth/login/password", { password: PASSWORD }, { "X-Forwarded-For": "198.51.100.7" });
    expect(fresh.status).toBe(429);
  });

  test("changing the password ends other sessions", async () => {
    const { app } = await fixture();
    const first = await setUp(app);
    const second = sessionCookie(await post(app, "/api/auth/login/password", { password: PASSWORD }));
    const newPassword = "an even better passphrase";
    expect((await post(app, "/api/auth/password", { currentPassword: "wrong password", newPassword }, { Cookie: first })).status).toBe(401);
    expect((await post(app, "/api/auth/password", { currentPassword: PASSWORD, newPassword }, { Cookie: first })).status).toBe(200);
    expect((await get(app, "/api/accounts", { Cookie: first })).status).toBe(200);
    expect((await get(app, "/api/accounts", { Cookie: second })).status).toBe(401);
    expect((await post(app, "/api/auth/login/password", { password: PASSWORD })).status).toBe(401);
    expect((await post(app, "/api/auth/login/password", { password: newPassword })).status).toBe(200);
  });
});

describe("sessions", () => {
  test("store only a hash of the token", async () => {
    const { app, auth } = await fixture();
    const cookie = await setUp(app);
    const token = cookie.split("=")[1]!;
    const [row] = auth.store.listSessions();
    expect(row?.tokenHash).not.toContain(token);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("expire after seven idle days", async () => {
    const { app, clock } = await fixture();
    const cookie = await setUp(app);
    clock.now += SESSION_IDLE_MS - 60_000;
    expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(200);
    clock.now += SESSION_IDLE_MS - 60_000;
    expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(200);
    clock.now += SESSION_IDLE_MS;
    expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(401);
  });

  test("expire thirty days after creation even when used daily", async () => {
    const { app, clock } = await fixture();
    const cookie = await setUp(app);
    for (let day = 1; day < 30; day += 1) {
      clock.now += 24 * 60 * 60 * 1000;
      expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(200);
    }
    clock.now = Date.parse("2026-10-01T09:00:00.000Z") + SESSION_ABSOLUTE_MS;
    expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(401);
  });

  test("logout ends the session and clears the cookie", async () => {
    const { app } = await fixture();
    const cookie = await setUp(app);
    const response = await post(app, "/api/auth/logout", {}, { Cookie: cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(401);
  });

  test("lists sessions and signs out the others", async () => {
    const { app } = await fixture();
    const current = await setUp(app);
    const other = sessionCookie(await post(app, "/api/auth/login/password", { password: PASSWORD }));
    const sessions = await (await get(app, "/api/auth/sessions", { Cookie: current })).json() as { current: boolean }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(await (await post(app, "/api/auth/sessions/revoke-others", {}, { Cookie: current })).json()).toEqual({ revoked: 1 });
    expect((await get(app, "/api/accounts", { Cookie: other })).status).toBe(401);
    expect((await get(app, "/api/accounts", { Cookie: current })).status).toBe(200);
  });

  test("cookies are HttpOnly, SameSite=Lax, and Secure only for https", async () => {
    const plain = await fixture();
    const header = (await post(plain.app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD })).headers.get("Set-Cookie")!;
    expect(header).toContain("postreeve-session=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Secure");

    const hosted = await fixture({ trust: { publicUrl: new URL("https://postreeve.example"), trustProxy: false } });
    const response = await post(hosted.app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }, {
      Host: "postreeve.example",
      Origin: "https://postreeve.example",
    });
    expect(response.status).toBe(201);
    const secure = response.headers.get("Set-Cookie")!;
    expect(secure.startsWith("__Host-postreeve-session=")).toBe(true);
    expect(secure).toContain("Secure");
    expect((await get(hosted.app, "/api/accounts", { Host: "postreeve.example", Cookie: sessionCookie(response) })).status).toBe(200);
  });

  test("ignore a forged forwarded scheme unless the proxy is trusted", async () => {
    const untrusted = await fixture();
    const header = (await post(untrusted.app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }, {
      "X-Forwarded-Proto": "https",
    })).headers.get("Set-Cookie")!;
    expect(header.startsWith("postreeve-session=")).toBe(true);

    const trusted = await fixture({ trust: { publicUrl: null, trustProxy: true } });
    const secure = (await post(trusted.app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }, {
      "X-Forwarded-Proto": "https",
      Origin: "https://127.0.0.1:3000",
    })).headers.get("Set-Cookie")!;
    expect(secure.startsWith("__Host-postreeve-session=")).toBe(true);
  });
});

describe("owner API guard", () => {
  test("answers unauthenticated API calls with 401, including events and attachments", async () => {
    const { app } = await fixture();
    for (const path of [
      "/api/accounts",
      "/api/events",
      "/api/accounts/account-1/messages/message-1/attachments/ref",
      "/api/oauth/google/start",
      "/api/oauth/google/callback?code=x&state=y",
      "/api/auth/passkeys",
      "/api/auth/sessions",
    ]) {
      const response = await get(app, path);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: "Authentication required", code: "unauthenticated" });
    }
    expect((await post(app, "/api/messages/send", {})).status).toBe(401);
  });

  test("leaves health and the sign-in endpoints public", async () => {
    const { app } = await fixture();
    expect((await get(app, "/api/health")).status).toBe(200);
    expect((await get(app, "/api/auth/session")).status).toBe(200);
    expect((await post(app, "/api/auth/logout", {})).status).toBe(200);
  });

  test("opens the event stream for the owner", async () => {
    const { app } = await fixture();
    const cookie = await setUp(app);
    const response = await get(app, "/api/events", { Cookie: cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    await response.body?.cancel();
  });

  test("closes an open event stream once its session is revoked", async () => {
    const { app } = await fixture({ eventKeepAliveMs: 20 });
    const cookie = await setUp(app);
    const response = await get(app, "/api/events", { Cookie: cookie });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("keep-alive");
    await post(app, "/api/auth/logout", {}, { Cookie: cookie });
    let done = false;
    for (let reads = 0; reads < 5 && !done; reads += 1) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  test("rejects a garbage cookie", async () => {
    const { app } = await fixture();
    await setUp(app);
    expect((await get(app, "/api/accounts", { Cookie: "postreeve-session=forged" })).status).toBe(401);
  });
});

describe("cross-site writes", () => {
  test("a session cookie alone does not authorize a cross-site write", async () => {
    const { app } = await fixture();
    const cookie = await setUp(app);
    const crossOrigin = await post(app, "/api/accounts/discover", { email: "a@example.test" }, {
      Cookie: cookie,
      Origin: "http://localhost:8080",
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ error: "Forbidden origin" });
    const noOrigin = await post(app, "/api/auth/logout", {}, { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
    expect(noOrigin.status).toBe(403);
    const sameSite = await post(app, "/api/auth/login/password", { password: PASSWORD }, { "Sec-Fetch-Site": "same-site" });
    expect(sameSite.status).toBe(403);
    expect((await get(app, "/api/accounts", { Cookie: cookie })).status).toBe(200);
  });

  test("accepts the public origin behind a plain-http proxy hop", async () => {
    const { app } = await fixture({ trust: { publicUrl: new URL("https://postreeve.example"), trustProxy: false } });
    const response = await post(app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }, {
      Host: "postreeve.example",
      Origin: "https://postreeve.example",
      "Sec-Fetch-Site": "same-origin",
    });
    expect(response.status).toBe(201);
  });
});

describe("desktop token", () => {
  test("keeps working unchanged without an owner", async () => {
    const { app } = await fixture({ desktopToken: "launch-secret" });
    const authorization = { Authorization: "Bearer launch-secret" };
    expect((await get(app, "/api/accounts", authorization)).status).toBe(200);
    expect((await get(app, "/api/health")).status).toBe(401);
    expect((await get(app, "/api/accounts", { Authorization: "Bearer wrong" })).status).toBe(401);
    const sent = await post(app, "/api/accounts/test", {}, { ...authorization, Origin: "postreeve://app" });
    expect(sent.status).toBe(400);
    expect(await (await get(app, "/api/auth/session", authorization)).json()).toMatchObject({
      state: "authenticated",
      desktop: true,
    });
  });
});

describe("requireOwner and getOwnerSession", () => {
  test("protect routes outside /api", async () => {
    const { auth, app: api } = await fixture();
    const cookie = await setUp(api);
    const app = new Hono();
    app.use("*", ownerAuthContext(auth));
    app.get("/consent", requireOwner, (context) => context.json({ session: getOwnerSession(context)?.method }));
    app.get("/peek", (context) => context.json({ session: getOwnerSession(context) }));
    expect((await app.request("/consent", { headers: { Host: LOOPBACK } })).status).toBe(401);
    expect(await (await app.request("/peek", { headers: { Host: LOOPBACK } })).json()).toEqual({ session: null });
    const allowed = await app.request("/consent", { headers: { Host: LOOPBACK, Cookie: cookie } });
    expect(await allowed.json()).toEqual({ session: "password" });
  });
});

describe("tailscale serve", () => {
  const tailnet: RequestTrust = { publicUrl: new URL("https://box.tail1234.ts.net"), trustProxy: true };
  const proxied = { Host: "127.0.0.1:3000", "X-Forwarded-Host": "box.tail1234.ts.net", "X-Forwarded-Proto": "https" };

  test("uses the ts.net host for passkeys and Secure cookies", async () => {
    const { app } = await fixture({ trust: tailnet });
    const options = await post(app, "/api/auth/login/passkey/options", {}, { ...proxied, Origin: "https://box.tail1234.ts.net" });
    expect(await options.json()).toMatchObject({ rpId: "box.tail1234.ts.net" });
    const setup = await post(app, "/api/auth/setup", { setupToken: SETUP_TOKEN, password: PASSWORD }, {
      ...proxied,
      Origin: "https://box.tail1234.ts.net",
    });
    expect(setup.status).toBe(201);
    expect(setup.headers.get("Set-Cookie")).toStartWith("__Host-postreeve-session=");
  });

  test("never treats Tailscale identity headers as authentication", async () => {
    const { app } = await fixture({ trust: tailnet });
    await setUp(app);
    const response = await get(app, "/api/accounts", {
      ...proxied,
      "Tailscale-User-Login": "owner@example.test",
      "Tailscale-User-Name": "Owner",
    });
    expect(response.status).toBe(401);
  });

  test("rate-limits by the address the proxy appended, not a client-supplied one", async () => {
    const { app } = await fixture({ trust: tailnet });
    await setUp(app);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post(app, "/api/auth/login/password", { password: "wrong password" }, {
        "X-Forwarded-For": `10.0.0.${attempt}, 100.64.0.9`,
      });
    }
    const blocked = await post(app, "/api/auth/login/password", { password: PASSWORD }, { "X-Forwarded-For": "10.9.9.9, 100.64.0.9" });
    expect(blocked.status).toBe(429);
  });
});

describe("passkeys", () => {
  test("are unavailable on an IP address and offered on localhost and the public URL", async () => {
    const { app } = await fixture({ trust: { publicUrl: new URL("https://postreeve.example"), trustProxy: false } });
    expect((await post(app, "/api/auth/login/passkey/options", {})).status).toBe(400);
    expect(await (await get(app, "/api/auth/session", { Host: "localhost:3000" })).json()).toMatchObject({ passkeys: true });
    const hosted = await post(app, "/api/auth/login/passkey/options", {}, { Host: "postreeve.example", Origin: "https://postreeve.example" });
    expect(hosted.status).toBe(200);
    expect(await hosted.json()).toMatchObject({ rpId: "postreeve.example" });
  });

  test("refuse an unknown credential and count it as a failure", async () => {
    const { app } = await fixture();
    await setUp(app);
    const response = await post(app, "/api/auth/login/passkey/verify", {
      response: { id: "unknown", rawId: "unknown", type: "public-key", response: {}, clientExtensionResults: {} },
    }, { Host: "localhost:3000" });
    expect(response.status).toBe(401);
  });

  test("registration options require the owner and exclude nothing at first", async () => {
    const { app } = await fixture();
    const cookie = await setUp(app);
    expect((await post(app, "/api/auth/passkeys/options", {}, { Host: "localhost:3000" })).status).toBe(401);
    const options = await post(app, "/api/auth/passkeys/options", {}, { Host: "localhost:3000", Cookie: cookie });
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ rp: { id: "localhost", name: "Postreeve" }, excludeCredentials: [] });
  });
});
