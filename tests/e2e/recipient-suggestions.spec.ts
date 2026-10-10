import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

test("suggests indexed correspondents in recipient fields and accepts them with the keyboard", async ({ page }) => {
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
      if (url.pathname === "/api/events") return route.abort();
      await route.fulfill({ response: await route.fetch({ url: `${base}${url.pathname}${url.search}` }) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "New message", exact: true }).click();
    const to = page.getByLabel("To", { exact: true });
    await to.pressSequentially("bob@x.test, SEND");
    const options = page.getByRole("listbox", { name: "To suggestions" }).getByRole("option");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("Sender 200");
    await expect(options.first()).toContainText("sender@example.test");
    await to.press("ArrowDown");
    await to.press("Enter");
    await expect(to).toHaveValue("bob@x.test, sender@example.test, ");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "New message" })).toBeVisible();

    const cc = page.getByLabel("Cc", { exact: true });
    await cc.pressSequentially("person");
    await page.waitForTimeout(400);
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await cc.fill("");
    await cc.pressSequentially("sender");
    await expect(page.getByRole("listbox", { name: "Cc suggestions" })).toBeVisible();
    await cc.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(cc).toBeFocused();
    await expect(cc).toHaveValue("sender");
  } finally { server.kill("SIGTERM"); }
});
