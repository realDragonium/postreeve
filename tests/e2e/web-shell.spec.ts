import { expect, test, type Page, type Route } from "./support/owner-session";
import { mailboxQuerySchema } from "../../src/shared/mailbox-query";
import {
  canonicalMessageSummarySchema,
  createDraftInputSchema,
  directActionInputSchema,
  updateDraftInputSchema,
  type Account,
  type CanonicalMessageDetail,
  type Draft,
  type Folder,
} from "../../src/shared/contracts";

const account: Account = { id: "account-work", name: "Work inbox", email: "alex@example.com", kind: "imap" };
const folders: Folder[] = [
  { path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 1, total: 2 },
  { path: "Sent", name: "Sent", specialUse: "sent", unread: 0, total: 0 },
  { path: "Archive", name: "Archive", specialUse: "archive", unread: 0, total: 4 },
  { path: "Trash", name: "Trash", specialUse: "trash", unread: 0, total: 0 },
];
const first: CanonicalMessageDetail = {
  attachments: [],
  canonicalId: "canonical-first",
  canonicalAliases: [],
  conversationId: "conversation-first",
  ref: { accountId: account.id, mailbox: "INBOX", uidValidity: "22", uid: 41, modseq: "8" },
  messageId: "first@example.com",
  subject: "Quarterly planning notes",
  from: [{ name: "Sam Rivera", address: "sam@example.com" }],
  to: [{ name: "Alex", address: account.email }],
  cc: [{ name: "Taylor", address: "taylor@example.com" }],
  receivedAt: "2026-08-29T08:30:00.000Z",
  preview: "Here are the decisions.",
  read: true,
  flagged: false,
  text: "Here are the decisions.",
  html: null,
};
const second: CanonicalMessageDetail = {
  ...first,
  canonicalId: "canonical-second",
  conversationId: "conversation-second",
  ref: { ...first.ref, uid: 42 },
  messageId: "second@example.com",
  subject: "Budget review",
  from: [{ name: "Jordan Lee", address: "jordan@example.com" }],
  read: false,
};

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

/** Deterministic API double that records what the page asked for. */
async function mockMailbox(page: Page, messages: CanonicalMessageDetail[] = [first, second]) {
  const calls = { actions: [] as string[], undos: 0, queries: [] as string[], attachments: 0 };
  const drafts: Draft[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/events") return route.abort();
    if (method === "GET" && path === "/api/accounts") return json(route, [account]);
    if (method === "GET" && path === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "GET" && path === `/api/accounts/${account.id}/folders`) return json(route, folders);
    if (method === "GET" && (path.endsWith("/identities") || path.endsWith("/signatures"))) return json(route, []);
    if (method === "GET" && path === "/api/outgoing-mail-limits") return json(route, { maxUploadBytes: 1_048_576, maxMessageBytes: 2_097_152 });
    if (method === "GET" && path === "/api/recipient-suggestions") return json(route, []);
    if (method === "POST" && path === "/api/messages/query") {
      const query = mailboxQuerySchema.parse(request.postDataJSON());
      const mailbox = query.sources[0]?.mailbox ?? "";
      calls.queries.push(mailbox);
      const page = mailbox === "INBOX" ? messages : [];
      return json(route, { messages: canonicalMessageSummarySchema.array().parse(page), nextCursor: null,
        coverage: { sources: [], complete: true, bodyTextLimit: 32768 } });
    }
    if (method === "POST" && path === "/api/messages/read") {
      const { references } = request.postDataJSON() as { references: { uid: number }[] };
      return json(route, references.map(({ uid }) => messages.find((message) => message.ref.uid === uid)).filter(Boolean));
    }
    if (method === "GET" && path.startsWith("/api/conversations/")) return json(route, []);
    if (method === "POST" && path === "/api/messages/actions") {
      const input = directActionInputSchema.parse(request.postDataJSON());
      calls.actions.push(JSON.stringify(input.items.map((item) => [item.message.uid, item.action])));
      return json(route, {
        id: `batch-${calls.actions.length}`, proposalId: "direct", accountId: account.id, status: "applied",
        operations: input.items.map((item, index) => ({ itemId: `item-${index}`, message: item.message, action: item.action, status: "applied", error: null })),
        createdAt: "2026-08-29T09:02:00.000Z", updatedAt: "2026-08-29T09:02:00.000Z",
      });
    }
    if (method === "POST" && /^\/api\/batches\/[^/]+\/undo$/.test(path)) {
      calls.undos += 1;
      return json(route, { error: "Undo must not be called in this test" }, 500);
    }
    if (method === "GET" && path === `/api/accounts/${account.id}/drafts`) return json(route, drafts);
    if (method === "POST" && path === `/api/accounts/${account.id}/drafts`) {
      const { clientId, ...content } = createDraftInputSchema.parse({ accountId: account.id, ...request.postDataJSON() });
      const draft: Draft = { ...content, id: clientId ?? "draft-1", delivery: { status: "editable" },
        mirror: { status: "pending" }, createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z", version: 1 } as Draft;
      drafts.splice(0, drafts.length, draft);
      return json(route, draft, 201);
    }
    if (method === "PUT" && path.startsWith(`/api/accounts/${account.id}/drafts/`)) {
      const { version, ...content } = updateDraftInputSchema.parse(request.postDataJSON());
      const draft = { ...drafts[0]!, ...content, version: version + 1 } as Draft;
      drafts.splice(0, drafts.length, draft);
      return json(route, draft);
    }
    if (method === "GET" && path.includes("/attachments/")) {
      calls.attachments += 1;
      if (path.endsWith("/broken-reference")) return json(route, { error: "Mailbox provider is temporarily unavailable" }, 503);
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: path.endsWith("/pdf-reference") ? Buffer.from("%PDF-1.4\n%%EOF\n") : png });
    }
    if (method === "GET" && (path === "/api/proposals" || path === "/api/batches")) return json(route, []);
    return json(route, { error: `Unhandled test route: ${method} ${path}` }, 404);
  });
  return calls;
}

test("undo keys in the rich-text editor never revert a mailbox action", async ({ page }) => {
  const calls = await mockMailbox(page);
  await page.goto("/");
  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();

  await page.keyboard.press("e");
  await expect.poll(() => calls.actions.length).toBe(1);
  await expect(page.getByRole("button", { name: "Undo ⌘Z" })).toBeVisible();

  await page.keyboard.press("c");
  const editor = page.getByLabel("Message", { exact: true });
  await editor.click();
  await page.keyboard.type("Hello ej[x#");
  await expect(editor).toContainText("Hello ej[x#");
  // Control+Z is the editor's own undo: it may revert the typing, but it must not reach the mailbox.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Meta+z");
  await page.keyboard.type("!");
  await expect(editor).toContainText("!");
  // Nothing outside the editor reacted: no undo request, no second archive, the sidebar is still open.
  expect(calls.undos).toBe(0);
  expect(calls.actions).toHaveLength(1);
  await expect(page.locator(".side")).toBeVisible();

  // Focus on a dialog button is not typing, but a dialog still blocks the undo shortcut.
  await page.getByRole("button", { name: "Bold" }).focus();
  await page.keyboard.press("Control+z");
  expect(calls.undos).toBe(0);
});

test("reply, forward, compose, trash, mark unread and go-to shortcuts", async ({ page }) => {
  const calls = await mockMailbox(page);
  await page.goto("/");
  await expect(page.getByText("Quarterly planning notes", { exact: true })).toBeVisible();

  await page.keyboard.press("r");
  await expect(page.getByRole("heading", { name: "Reply", exact: true })).toBeVisible();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("sam@example.com");
  await page.getByRole("button", { name: "Close Reply" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  await page.keyboard.press("a");
  await expect(page.getByRole("heading", { name: "Reply all", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Reply all" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  await page.keyboard.press("f");
  await expect(page.getByRole("heading", { name: "Forward", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Forward" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  await page.keyboard.press("c");
  await expect(page.getByRole("heading", { name: "New message", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close New message" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);

  await page.keyboard.press("Shift+U");
  await expect.poll(() => calls.actions.at(-1)).toBe(JSON.stringify([[41, { type: "mark_unread" }]]));

  await page.keyboard.press("j");
  await page.keyboard.press("#");
  await expect.poll(() => calls.actions.at(-1)).toBe(JSON.stringify([[42, { type: "trash" }]]));

  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page.locator(".scope-title")).toHaveText("alex@example.com · Sent");
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.locator(".scope-title")).toHaveText("alex@example.com · Trash");
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page.locator(".scope-title")).toHaveText("alex@example.com · Inbox");
});

test("the help overlay lists every shortcut and closes with Escape", async ({ page }) => {
  await mockMailbox(page);
  await page.goto("/");
  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  for (const [key, description] of [["r", "Reply"], ["#", "Move to Trash"], ["g then i", "Go to Inbox"], ["shift U", "Mark unread"], ["?", "Show keyboard shortcuts"]] as const) {
    await expect(help.locator(".shortcut-row").filter({ has: page.getByText(description, { exact: true }) }).locator("kbd")).toHaveText(key);
  }
  // Shortcuts are paused while help is open.
  await page.keyboard.press("j");
  await expect(page.locator(".row.focus")).toContainText("Quarterly planning notes");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("a reader crash shows a recoverable fallback and keeps the list working", async ({ page }) => {
  await page.addInitScript(() => {
    // Only the reader formats a date with both a day and a minute, so this breaks the reader alone.
    const Original = Intl.DateTimeFormat;
    const Patched = function (this: unknown, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      if (Reflect.get(window, "crashReader") && options?.day && options.minute) throw new Error("Simulated <b>reader</b> failure");
      return new Original(locales, options);
    } as unknown as typeof Intl.DateTimeFormat;
    Object.defineProperty(Patched, "prototype", { value: Original.prototype });
    Intl.DateTimeFormat = Patched;
    Reflect.set(window, "crashReader", true);
  });
  await mockMailbox(page);
  await page.goto("/");
  await page.getByText("Quarterly planning notes", { exact: true }).click();
  const fallback = page.getByRole("alert", { name: "reader error" });
  await expect(fallback).toContainText("Something went wrong");
  await expect(fallback.locator(".crash-message")).toHaveText("Simulated <b>reader</b> failure");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();

  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.set(window, "crashReader", false));
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Quarterly planning notes" })).toBeVisible();
});

test("phone layout: drawer, two-line rows, full-screen compose and back closes the reader", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockMailbox(page);
  await page.goto("/");
  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();
  await expect(page.locator(".side")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/phone-list.png" });

  const row = await page.locator(".row").first().boundingBox();
  expect(row!.height).toBeGreaterThanOrEqual(44);
  const menu = await page.getByRole("button", { name: "Show sidebar" }).boundingBox();
  expect(menu!.height).toBeGreaterThanOrEqual(44);

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.locator(".side")).toBeVisible();
  await page.screenshot({ path: "test-results/phone-drawer.png" });
  await page.getByRole("button", { name: /^Sent\b/ }).click();
  await expect(page.locator(".side")).toBeHidden();
  await expect(page.locator(".scope-title")).toHaveText("alex@example.com · Sent");
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.getByRole("button", { name: /^Inbox\b/ }).click();

  await page.getByText("Budget review", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Budget review" })).toBeVisible();
  await expect(page.getByLabel("Mailbox list")).toBeHidden();
  await page.screenshot({ path: "test-results/phone-reader.png" });
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Budget review" })).toHaveCount(0);
  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");

  await page.getByRole("button", { name: "New message" }).click();
  const sheet = await page.locator(".sheet").boundingBox();
  expect(sheet!.x).toBe(0);
  expect(sheet!.width).toBe(390);
  expect(sheet!.height).toBeGreaterThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/phone-compose.png" });
});

test("previews image attachments inline and opens PDFs in a new tab", async ({ page, context }) => {
  const attached: CanonicalMessageDetail = {
    ...first,
    attachments: [
      { reference: "image-reference", canonicalMessageId: first.canonicalId, filename: "photo.png", mediaType: "image/png", size: 68, sizeIsEstimate: false },
      { reference: "svg-reference", canonicalMessageId: first.canonicalId, filename: "logo.svg", mediaType: "image/svg+xml", size: 300, sizeIsEstimate: false },
      { reference: "pdf-reference", canonicalMessageId: first.canonicalId, filename: "report.pdf", mediaType: "application/pdf", size: 20, sizeIsEstimate: false },
      { reference: "broken-reference", canonicalMessageId: first.canonicalId, filename: "scan.jpg", mediaType: "image/jpeg", size: 20, sizeIsEstimate: false },
    ],
  };
  const violations: string[] = [];
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await mockMailbox(page, [attached]);
  await page.goto("/");
  await page.getByText("Quarterly planning notes", { exact: true }).click();

  const previews = page.getByLabel("Attachment previews");
  const image = previews.getByRole("img", { name: "photo.png" });
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  expect(await image.getAttribute("src")).toMatch(/^blob:/);
  await expect(previews.getByText("logo.svg")).toHaveCount(0);
  await expect(previews.getByRole("alert")).toContainText("Mailbox provider is temporarily unavailable");
  await expect(page.getByRole("button", { name: /Download photo\.png/ })).toBeEnabled();

  const opened = context.waitForEvent("page");
  await previews.getByRole("button", { name: "Preview report.pdf" }).click();
  const tab = await opened;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  expect(violations).toEqual([]);
});
