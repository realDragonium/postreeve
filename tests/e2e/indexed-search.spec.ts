import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

test("pages beyond 100 across accounts and searches unopened retained body content", async ({ page, request }) => {
  const server = spawn("bun", ["--no-env-file", "tests/fixtures/indexed-search-server.ts"], { stdio: ["ignore", "pipe", "pipe"] });
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    server.on("error", reject);
    server.on("exit", code => reject(new Error(`Indexed fixture exited with ${code}`)));
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
  });
  try {
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${base}${url.pathname}${url.search}` }) });
    });
    await page.goto("/");
    const rows = page.getByLabel("Messages", { exact: true }).locator("button.row");
    await expect(rows).toHaveCount(50);
    await page.getByRole("button", { name: "Load 50 more", exact: true }).click();
    await expect(rows).toHaveCount(100);
    await page.getByRole("button", { name: "Load 50 more", exact: true }).click();
    await expect(rows).toHaveCount(150);
    await page.getByRole("button", { name: "Load 50 more", exact: true }).click();
    await expect(rows).toHaveCount(200);
    await expect(page.getByRole("button", { name: "Load 50 more", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Oldest", exact: true }).click();
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText("Indexed letter 001");
    await page.getByLabel("Search messages").fill("unopened-body-needle");
    await page.getByLabel("Search messages").press("Enter");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Indexed letter 137");
    await request.post(`${base}/scenario/expire`);
    await page.getByRole("button", { name: "Newest", exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole("note", { name: "Mailbox coverage" })).toContainText("Provider fallback failed");
    await page.getByLabel("Search messages").fill("Indexed letter 137");
    await page.getByLabel("Search messages").press("Enter");
    await expect(rows).toHaveCount(1);
  } finally { server.kill("SIGTERM"); }
});
