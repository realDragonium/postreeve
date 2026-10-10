import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import { draftSchema } from "../../src/shared/contracts";

test("formats a message and swaps the identity signature without touching typed text", async ({ page, request }) => {
  const process = spawn("bun", ["--no-env-file", "tests/fixtures/rich-compose-server.ts"], { stdio: ["ignore", "pipe", "pipe"] });
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    process.on("error", reject);
    process.on("exit", (code) => reject(new Error(`Synthetic API exited with ${code}`)));
    process.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
  });
  try {
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${base}${url.pathname}${url.search}` }) });
    });
    await page.goto("/");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Identities" }).click();
    for (const [address, signature] of [["person@example.test", "Person at Work"], ["sales@example.test", "Sales team"]] as const) {
      await page.getByRole("button", { name: `Signature for ${address}` }).click();
      await page.getByLabel("Signature", { exact: true }).fill(signature);
      await page.getByRole("button", { name: "Save signature" }).click();
      await expect(page.getByLabel("Signature", { exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Close Identities" }).click();
    await page.getByRole("button", { name: "Mailbox", exact: true }).click();

    await page.getByRole("button", { name: "New message", exact: true }).click();
    const editor = page.getByLabel("Message", { exact: true });
    await expect(editor.locator("[data-postreeve-signature]")).toHaveText("Person at Work");
    await page.getByRole("button", { name: "Close New message" }).click();
    expect(draftSchema.array().parse(await (await request.get(`${base}/api/accounts/${await accountId(request, base)}/drafts`)).json())).toEqual([]);

    await page.getByRole("button", { name: "New message", exact: true }).click();
    await page.getByLabel("To", { exact: true }).fill("recipient@example.test");
    await page.getByLabel("Subject", { exact: true }).fill("Formatted");
    await editor.locator("div").first().click();
    await page.keyboard.type("Hello ");
    await page.getByRole("button", { name: "Bold" }).click();
    await page.keyboard.type("world");
    await page.getByLabel("From identity").selectOption("sales@example.test");
    await expect(editor.locator("[data-postreeve-signature]")).toHaveText("Sales team");
    await expect(editor.locator("b")).toHaveText("world");

    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("heading", { name: "Message sent" })).toBeVisible();
    const sent = await (await request.get(`${base}/sent`)).json() as Array<{ text: string; html?: string; from?: { address: string } }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.from?.address).toBe("sales@example.test");
    expect(sent[0]?.html).toContain("<b>world</b>");
    expect(sent[0]?.html).toContain("Sales team");
    expect(sent[0]?.html).not.toContain("Person at Work");
    expect(sent[0]?.text).toBe("Hello world\n\nSales team");
  } finally {
    process.kill("SIGTERM");
  }
});

async function accountId(request: import("@playwright/test").APIRequestContext, base: string): Promise<string> {
  const accounts = await (await request.get(`${base}/api/accounts`)).json() as Array<{ id: string }>;
  return accounts[0]!.id;
}
