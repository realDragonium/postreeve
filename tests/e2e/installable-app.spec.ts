import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

// Runs the real production server, so the bundle, the security headers and the service worker meet as they do in use.
test("the production server serves an installable app whose worker caches only the shell", async ({ page }) => {
  execFileSync("bun", ["run", "build"], { stdio: "ignore" });
  const port = String(4300 + Math.floor(Math.random() * 500));
  const server = spawn("bun", ["--no-env-file", "src/server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: port, POSTREEVE_DB_PATH: ":memory:", POSTREEVE_MASTER_KEY: randomBytes(32).toString("base64") },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await expect.poll(async () => (await fetch(`${base}/api/health`).catch(() => null))?.status ?? 0, { timeout: 15_000 }).toBe(200);
    const violations: string[] = [];
    // The Google Fonts stylesheet in index.html is already blocked by style-src; that predates the installable app.
    page.on("console", (message) => {
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text) && !text.includes("fonts.googleapis.com")) violations.push(text);
    });

    await page.goto(base);
    await expect(page.locator(".brand")).toHaveText("POSTREEVE");
    expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
    const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json() as {
      name: string; display: string; start_url: string; icons: { sizes: string; purpose: string }[];
    };
    expect(manifest).toMatchObject({ name: "Postreeve", display: "standalone", start_url: "/" });
    expect(manifest.icons.map(({ sizes, purpose }) => `${sizes} ${purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]) {
      expect((await page.request.get(`${base}${icon}`)).headers()["content-type"]).toBe("image/png");
    }

    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(`${base}/`);
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await expect(page.locator(".brand")).toHaveText("POSTREEVE");
    await page.evaluate(() => fetch("/api/accounts"));
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });
    expect(cached).toContain("/");
    expect(cached.some((path) => path.startsWith("/assets/"))).toBe(true);
    expect(cached.filter((path) => path.startsWith("/api"))).toEqual([]);
    expect(violations).toEqual([]);
  } finally {
    server.kill("SIGTERM");
  }
});
