import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import { accountSchema, draftSchema } from "../../src/shared/contracts";

test("real API keeps rejected and uncertain attachments recoverable without automatic delivery", async ({ page, request }) => {
  const process = spawn("bun", ["--no-env-file", "tests/fixtures/draft-files-server.ts"], { stdio: ["ignore", "pipe", "pipe"] });
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
    await request.post(`${base}/scenario`, { data: { reject: true, uncertain: false } });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${base}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    const accounts = accountSchema.array().parse(await (await request.get(`${base}/api/accounts`)).json());
    const account = accounts[0]!;
    const draftsUrl = `${base}/api/accounts/${account.id}/drafts`;
    await page.goto("/");
    await page.getByRole("button", { name: "New message", exact: true }).click();
    await expect(page.getByText("Up to 1 KiB per file; 12,000 bytes per encoded message.")).toBeVisible();
    await page.getByLabel("To", { exact: true }).fill("recipient@example.test");
    await page.getByLabel("Subject", { exact: true }).fill("Review uncertain attachment delivery");
    await page.getByLabel("Message", { exact: true }).fill("Keep the original text and files.");
    const bytes = Buffer.from([0, 255, 128, 42]);
    await page.locator('input[type="file"]').setInputFiles({ name: "content.bin", mimeType: "application/octet-stream", buffer: bytes });
    await expect(page.getByText("content.bin", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/No recipients accepted the message/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Message sent" })).toHaveCount(0);
    let drafts = draftSchema.array().parse(await (await request.get(draftsUrl)).json());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.delivery.status).toBe("failed");
    const fileId = drafts[0]!.attachments[0]!.id!;
    expect(await (await request.get(`${draftsUrl}/${drafts[0]!.id}/files/${fileId}`)).body()).toEqual(bytes);
    await request.post(`${base}/scenario`, { data: { reject: false, uncertain: true } });
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/Delivery is uncertain/)).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    drafts = draftSchema.array().parse(await (await request.get(draftsUrl)).json());
    const original = drafts[0]!;
    expect(original.delivery.status).toBe("uncertain");
    await page.getByRole("button", { name: "Create a copy to review" }).click();
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(original.body);
    await expect(page.getByText("content.bin", { exact: true })).toBeVisible();
    drafts = draftSchema.array().parse(await (await request.get(draftsUrl)).json());
    expect(drafts).toHaveLength(2);
    const copy = drafts.find(({ id }) => id !== original.id)!;
    expect(copy.delivery.status).toBe("editable");
    expect(copy.attachments).toEqual(original.attachments);
    expect((await (await request.get(`${base}/attempts`)).json()).attempts).toBe(2);
    expect(await (await request.get(`${draftsUrl}/${copy.id}/files/${fileId}`)).body()).toEqual(bytes);
    await page.getByText("content.bin", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/dra482-recovery-copy.png", fullPage: true });
    await request.post(`${base}/scenario`, { data: { reject: true, uncertain: false } });
    await page.getByLabel("Cc", { exact: true }).fill("accepted@example.test");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("heading", { name: "Message sent" })).toBeVisible();
    await expect(page.getByText("Rejected: recipient@example.test", { exact: true })).toBeVisible();
    expect((await (await request.get(`${base}/attempts`)).json()).attempts).toBe(3);
    drafts = draftSchema.array().parse(await (await request.get(draftsUrl)).json());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.id).toBe(original.id);
    expect(drafts[0]?.delivery.status).toBe("uncertain");
  } finally {
    process.kill("SIGTERM");
  }
});
