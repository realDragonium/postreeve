import { expect, test, type Page, type Route } from "@playwright/test";
import {
  createFolderInputSchema,
  createAccountInputSchema,
  deleteFolderInputSchema,
  directActionInputSchema,
  messageSummarySchema,
  renameFolderInputSchema,
  sendMessageInputSchema,
  type Account,
  type Folder,
  type MessageDetail,
  type OperationBatch,
  type SendMessageInput,
} from "../../src/shared/contracts";

const account: Account = {
  id: "account-work",
  name: "Work inbox",
  email: "alex@example.com",
  kind: "imap",
};

const folders: Folder[] = [
  { path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 1, total: 1 },
  { path: "Archive", name: "Archive", specialUse: "archive", unread: 0, total: 4 },
  { path: "Trash", name: "Trash", specialUse: "trash", unread: 0, total: 0 },
];

const messageRef: MessageDetail["ref"] = {
  accountId: account.id,
  mailbox: "INBOX",
  uidValidity: "22",
  uid: 41,
  modseq: "8",
};

const message: MessageDetail = {
  canonicalId: "canonical-message",
  ref: messageRef,
  messageId: "message@example.com",
  subject: "Quarterly planning notes",
  from: [{ name: "Sam Rivera", address: "sam@example.com" }],
  to: [{ name: "Alex", address: account.email }],
  deliveredTo: ["planning-alias@example.com"],
  receivedAt: "2026-08-29T08:30:00.000Z",
  preview: "Here are the decisions and follow-ups from our quarterly planning session.",
  read: false,
  flagged: false,
  text: "Here are the decisions and follow-ups.",
  html: `
    <style>.email-card { color: rgb(18, 52, 86); font-weight: 700; }</style>
    <div class="email-card" style="background-color: rgb(238, 238, 238)">
      Here are the <strong>decisions</strong> and follow-ups.
    </div>
    <img class="tracker" src="https://tracker.invalid/pixel.gif">
    <img class="protocol-relative" src="//tracker.invalid/protocol.gif">
    <img class="responsive" srcset="https://tracker.invalid/responsive.gif 1x">
    <img class="lazy" data-src="https://tracker.invalid/lazy.gif">
    <div class="remote-background" style="background-image: url('//tracker.invalid/background.gif')"></div>
    <img class="embedded" alt="Embedded image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    <script>window.parent.compromised = true</script>
  `,
};

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function installWebMcpHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface BrowserTool {
      readonly name: string;
      execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown>;
    }
    const tools = new Map<string, BrowserTool>();
    const modelContext = {
      async registerTool(tool: BrowserTool, options?: { signal?: AbortSignal }): Promise<void> {
        tools.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name);
        }, { once: true });
      },
    };
    Object.defineProperty(document, "modelContext", { value: modelContext });
    Reflect.set(window, "postreeveWebMcpHarness", {
      names: () => [...tools.keys()],
      execute: (name: string, input: unknown) => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Missing tool: ${name}`);
        return tool.execute(input, { signal: new AbortController().signal });
      },
    });
  });
}

test("sends and manages mail, then inspects and undoes activity", async ({ page }) => {
  let sentMessage: SendMessageInput | null = null;
  let folderRequests = 0;
  let messageRequests = 0;
  let batch: OperationBatch | null = null;
  let lastMessageQuery = "";
  let liveFolders = structuredClone(folders);
  let remoteImageRequests = 0;

  await installWebMcpHarness(page);

  await page.route("https://tracker.invalid/**", async (route) => {
    remoteImageRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "image/gif",
      body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (method === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/folders`) {
      folderRequests += 1;
      return json(route, liveFolders);
    }
    if (method === "POST" && url.pathname === `/api/accounts/${account.id}/folders`) {
      const input = createFolderInputSchema.parse({ accountId: account.id, ...request.postDataJSON() });
      liveFolders = [...liveFolders, { path: input.name, name: input.name, specialUse: null, unread: 0, total: 0 }];
      return json(route, liveFolders, 201);
    }
    if (method === "PUT" && url.pathname === `/api/accounts/${account.id}/folders`) {
      const input = renameFolderInputSchema.parse({ accountId: account.id, ...request.postDataJSON() });
      liveFolders = liveFolders.map((folder) => folder.path === input.path
        ? { ...folder, path: input.name, name: input.name }
        : folder);
      return json(route, liveFolders);
    }
    if (method === "DELETE" && url.pathname === `/api/accounts/${account.id}/folders`) {
      const input = deleteFolderInputSchema.parse({ accountId: account.id, ...request.postDataJSON() });
      liveFolders = liveFolders.filter(({ path }) => path !== input.path);
      return json(route, liveFolders);
    }
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/messages`) {
      messageRequests += 1;
      lastMessageQuery = url.searchParams.get("query") ?? "";
      return json(route, url.searchParams.get("mailbox") === "INBOX" ? [message] : []);
    }
    if (method === "POST" && url.pathname === "/api/messages/read") return json(route, [message]);
    if (method === "POST" && url.pathname === "/api/messages/send") {
      sentMessage = sendMessageInputSchema.parse(request.postDataJSON());
      return json(route, {
        id: "sent-1",
        accountId: account.id,
        messageId: "sent-message@example.com",
        accepted: sentMessage.to.map((recipient) => recipient.address),
        rejected: [],
        submittedAt: "2026-08-29T09:01:00.000Z",
      });
    }
    if (method === "POST" && url.pathname === "/api/messages/actions") {
      const input = directActionInputSchema.parse(request.postDataJSON());
      batch = {
        id: "direct-batch-1",
        proposalId: "direct-action-1",
        accountId: account.id,
        status: "applied",
        operations: input.items.map((item, index) => ({ itemId: `direct-${index}`, message: item.message, action: item.action, status: "applied", error: null })),
        createdAt: "2026-08-29T09:02:00.000Z",
        updatedAt: "2026-08-29T09:02:00.000Z",
      };
      return json(route, batch);
    }
    if (method === "GET" && url.pathname === "/api/proposals") return json(route, []);
    if (method === "GET" && url.pathname === "/api/batches") return json(route, batch ? [batch] : []);
    if (method === "POST" && url.pathname === "/api/batches/direct-batch-1/undo" && batch) {
      batch = {
        ...batch,
        status: "undone",
        updatedAt: "2026-08-29T09:08:00.000Z",
        operations: batch.operations.map((operation) => ({ ...operation, status: "undone" })),
      };
      return json(route, batch);
    }
    return json(route, { error: `Unhandled test route: ${method} ${url.pathname}` }, 404);
  });

  await page.clock.install();
  await page.goto("/");
  await expect(page.getByText("Work inbox · Inbox", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`${account.email} · Inbox`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Newest", exact: true })).toHaveAttribute("aria-pressed", "true");

  await expect.poll(() => page.evaluate(() => {
    const harness: unknown = Reflect.get(window, "postreeveWebMcpHarness");
    if (typeof harness !== "object" || harness === null) return [];
    const names: unknown = Reflect.get(harness, "names");
    return typeof names === "function" ? names() : [];
  })).toContain("search_messages");
  const searchResult = await page.evaluate(async () => {
    const harness: unknown = Reflect.get(window, "postreeveWebMcpHarness");
    if (typeof harness !== "object" || harness === null) throw new Error("Missing WebMCP harness");
    const execute: unknown = Reflect.get(harness, "execute");
    if (typeof execute !== "function") throw new Error("Missing WebMCP executor");
    return execute("search_messages", {
      accountId: "account-work",
      mailbox: "INBOX",
      query: "quarterly planning",
      filter: "unread",
      sort: "oldest",
    });
  });
  expect(searchResult).toEqual([messageSummarySchema.parse(message)]);
  expect(lastMessageQuery).toBe("quarterly planning");
  await expect(page.getByLabel("Search messages")).toHaveValue("quarterly planning");
  await expect(page.getByRole("button", { name: "Unread", exact: true }).first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Oldest", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("matching “quarterly planning”")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("WebMCP updated the visible mailbox view.");

  await page.evaluate(async () => {
    const harness: unknown = Reflect.get(window, "postreeveWebMcpHarness");
    if (typeof harness !== "object" || harness === null) throw new Error("Missing WebMCP harness");
    const execute: unknown = Reflect.get(harness, "execute");
    if (typeof execute !== "function") throw new Error("Missing WebMCP executor");
    await execute("create_folder", { accountId: "account-work", name: "Agent folder" });
  });
  await expect(page.getByRole("button", { name: /Agent folder/ })).toBeVisible();

  await page.getByRole("button", { name: "Manage folders" }).click();
  await expect(page.getByRole("heading", { name: "Manage folders" })).toBeVisible();
  await page.getByLabel("New folder name").fill("Receipts");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByRole("article", { name: "Receipts" })).toBeVisible();
  await page.getByRole("article", { name: "Receipts" }).getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Rename Receipts").fill("Keep");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("article", { name: "Keep" })).toBeVisible();
  await page.getByRole("article", { name: "Keep" }).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete Keep" }).click();
  await expect(page.getByRole("article", { name: "Keep" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close Manage folders" }).click();

  const initialFolderRequests = folderRequests;
  await page.clock.fastForward(15_000);
  await expect.poll(() => folderRequests).toBeGreaterThan(initialFolderRequests);

  await page.getByRole("button", { name: "New message" }).click();
  await expect(page.getByLabel("From identity")).toHaveValue("alex@example.com");
  await page.getByLabel("To", { exact: true }).fill("jordan@example.com, taylor@example.com");
  await page.getByLabel("Cc", { exact: true }).fill("team@example.com");
  await page.getByLabel("Subject", { exact: true }).fill("Planning follow-up");
  await page.getByLabel("Message", { exact: true }).fill("Here are the next steps from our planning session.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "Message sent" })).toBeVisible();
  expect(sentMessage).toMatchObject({ accountId: account.id, subject: "Planning follow-up", text: "Here are the next steps from our planning session." });
  await expect.poll(() => messageRequests).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "New message" }).click();
  await page.getByLabel("Subject", { exact: true }).fill("Locally saved idea");
  await page.getByLabel("Message", { exact: true }).fill("Keep this as a draft for now.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Close New message" }).click();
  await page.getByRole("button", { name: /Local drafts/ }).click();
  await expect(page.getByText("Locally saved idea", { exact: true })).toBeVisible();
  await page.getByText("Locally saved idea", { exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this as a draft for now.");
  await page.getByRole("button", { name: "Close Edit draft" }).click();

  await page.getByLabel("Clear search").click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByText("Quarterly planning notes", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Quarterly planning notes" })).toBeVisible();
  await expect(page.getByLabel("Messages").getByText("Quarterly planning notes", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Messages").getByRole("button", { name: /Quarterly planning notes/ })).toHaveAttribute("aria-current", "true");
  const listPane = await page.getByLabel("Mailbox list").boundingBox();
  const readerPane = await page.getByLabel("Message reader").boundingBox();
  expect(listPane).not.toBeNull();
  expect(readerPane).not.toBeNull();
  expect(listPane!.x + listPane!.width).toBeLessThanOrEqual(readerPane!.x);
  expect(await page.getByLabel("Mailbox list").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.getByLabel("Message reader").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByText("delivered to planning-alias@example.com", { exact: true })).toBeVisible();
  await expect(page.getByText("Remote images blocked to protect your privacy.")).toBeVisible();
  const emailFrame = page.locator('iframe[title="Quarterly planning notes"]');
  const emailBody = page.frameLocator('iframe[title="Quarterly planning notes"]');
  await expect(emailFrame).toHaveAttribute("sandbox", /allow-same-origin/);
  expect(await emailFrame.getAttribute("sandbox")).not.toContain("allow-scripts");
  await expect(emailBody.locator(".email-card")).toHaveCSS("color", "rgb(18, 52, 86)");
  await expect(emailBody.locator(".email-card")).toHaveCSS("background-color", "rgb(238, 238, 238)");
  await expect(emailBody.locator("img.tracker")).not.toHaveAttribute("src");
  await expect(emailBody.locator("img.protocol-relative")).not.toHaveAttribute("src");
  await expect(emailBody.locator("img.responsive")).not.toHaveAttribute("srcset");
  await expect(emailBody.locator("img.lazy")).not.toHaveAttribute("src");
  await expect(emailBody.locator("img.embedded")).toHaveAttribute("src", /^data:image\/gif;base64,/);
  await expect(emailBody.locator("img.embedded")).not.toHaveClass(/postreeve-blocked-image/);
  await expect(emailBody.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "compromised"))).toBeUndefined();
  expect(remoteImageRequests).toBe(0);

  await page.getByRole("button", { name: "Load images" }).click();
  await expect(emailBody.locator("img.tracker")).toHaveAttribute("src", "https://tracker.invalid/pixel.gif");
  await expect(emailBody.locator("img.protocol-relative")).toHaveAttribute("src", "https://tracker.invalid/protocol.gif");
  await expect(emailBody.locator("img.responsive")).toHaveAttribute("srcset", "https://tracker.invalid/responsive.gif 1x");
  await expect(emailBody.locator("img.lazy")).toHaveAttribute("src", "https://tracker.invalid/lazy.gif");
  await expect(emailBody.locator(".remote-background")).toHaveAttribute("style", /https:\/\/tracker\.invalid\/background\.gif/);
  await expect.poll(() => remoteImageRequests).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("sam@example.com");
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("Re: Quarterly planning notes");
  await expect(page.getByText("Frontend ready, backend pending.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("button", { name: "Close Reply" }).click();

  await page.getByLabel("Move message to").selectOption("Archive");
  await expect(page.getByRole("status")).toContainText("Moved 1 to Archive");

  await page.getByRole("button", { name: "Activity", exact: true }).first().click();
  await expect(page.getByText("moved to Archive", { exact: true })).toBeVisible();
  await expect(page.getByText("you", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("moved to Archive (undone)", { exact: true })).toBeVisible();
});

test("reads a message and returns to the list on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (request.method() === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (request.method() === "GET" && url.pathname === `/api/accounts/${account.id}/folders`) return json(route, folders);
    if (request.method() === "GET" && url.pathname === `/api/accounts/${account.id}/messages`) return json(route, [message]);
    if (request.method() === "POST" && url.pathname === "/api/messages/read") return json(route, [message]);
    if (request.method() === "GET" && url.pathname === "/api/proposals") return json(route, []);
    if (request.method() === "GET" && url.pathname === "/api/batches") return json(route, []);
    return json(route, { error: `Unhandled test route: ${request.method()} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await page.getByText(message.subject, { exact: true }).click();
  await expect(page.getByRole("heading", { name: message.subject })).toBeVisible();
  await expect(page.getByLabel("Mailbox list")).toBeHidden();
  await page.getByRole("button", { name: "← Inbox" }).click();
  await expect(page.getByRole("heading", { name: message.subject })).toHaveCount(0);
  await expect(page.getByText(message.subject, { exact: true })).toBeVisible();
});

test("keyboard shortcuts open, move through and archive mail", async ({ page }) => {
  const second: MessageDetail = {
    ...message,
    canonicalId: "canonical-second",
    ref: { ...messageRef, uid: 42 },
    messageId: "second@example.com",
    subject: "Budget review",
    read: true,
  };
  const applied: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (request.method() === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (request.method() === "GET" && url.pathname === `/api/accounts/${account.id}/folders`) return json(route, folders);
    if (request.method() === "GET" && url.pathname === `/api/accounts/${account.id}/messages`) {
      return json(route, url.searchParams.get("mailbox") === "INBOX" ? [message, second] : []);
    }
    if (request.method() === "POST" && url.pathname === "/api/messages/read") {
      const { references } = request.postDataJSON();
      const uid = references[0]?.uid;
      return json(route, [uid === second.ref.uid ? second : message]);
    }
    if (request.method() === "POST" && url.pathname === "/api/messages/actions") {
      const input = directActionInputSchema.parse(request.postDataJSON());
      applied.push(JSON.stringify(input.items.map((item) => [item.message.uid, item.action])));
      return json(route, {
        id: "kb-batch", proposalId: "kb", accountId: account.id, status: "applied",
        operations: input.items.map((item, index) => ({ itemId: `kb-${index}`, message: item.message, action: item.action, status: "applied", error: null })),
        createdAt: "2026-08-29T09:02:00.000Z", updatedAt: "2026-08-29T09:02:00.000Z",
      });
    }
    if (request.method() === "GET" && url.pathname === "/api/proposals") return json(route, []);
    if (request.method() === "GET" && url.pathname === "/api/batches") return json(route, []);
    return json(route, { error: `Unhandled test route: ${request.method()} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();

  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Budget review" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByRole("heading", { name: "Quarterly planning notes" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Quarterly planning notes" })).toHaveCount(0);

  await page.keyboard.press("e");
  await expect.poll(() => applied).toContain(JSON.stringify([[41, { type: "move", destination: "Archive" }]]));

  const listWithSidebar = await page.locator(".list").boundingBox();
  await page.keyboard.press("[");
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect(page.locator(".side")).toBeHidden();
  // Hiding the sidebar takes it out of the grid, so the list has to claim its track.
  await expect(page.getByText("Budget review", { exact: true })).toBeVisible();
  const listWithoutSidebar = await page.locator(".list").boundingBox();
  expect(listWithoutSidebar!.width).toBeGreaterThan(listWithSidebar!.width);
  expect(listWithoutSidebar!.x).toBe(0);

  await page.keyboard.press("[");
  await expect(page.locator(".side")).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search messages")).toBeFocused();
});

test("shows and selects a newly connected account without a reload", async ({ page }) => {
  const personal: Account = { id: "account-personal", name: "Personal", email: "person@example.com", kind: "imap" };
  const work: Account = { id: "account-new-work", name: "New work", email: "person@work.example", kind: "imap" };
  let created = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET" && url.pathname === "/api/accounts") return json(route, created ? [personal, work] : [personal]);
    if (method === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "POST" && url.pathname === "/api/accounts") {
      createAccountInputSchema.parse(request.postDataJSON());
      created = true;
      return json(route, work, 201);
    }
    if (method === "GET" && url.pathname.endsWith("/folders")) {
      return json(route, [{ path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 0, total: 0 }]);
    }
    if (method === "GET" && url.pathname.endsWith("/messages")) return json(route, []);
    if (method === "GET" && url.pathname === "/api/proposals") return json(route, []);
    if (method === "GET" && url.pathname === "/api/batches") return json(route, []);
    return json(route, { error: `Unhandled test route: ${method} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByLabel("Name", { exact: true }).fill(work.name);
  await page.getByLabel("Email address").fill(work.email);
  await page.getByLabel("IMAP host").fill("imap.work.example");
  await page.getByLabel("Username").first().fill(work.email);
  await page.getByLabel(/Password/).first().fill("incoming-password");
  await page.getByRole("button", { name: "Connect account" }).click();

  await expect(page.getByText(work.email, { exact: true })).toBeVisible();
  await expect(page.getByText(`${work.email} · Inbox`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unified" })).toBeVisible();
});

test("starts with real account onboarding when no mailbox is connected", async ({ page }) => {
  await page.route("**/api/accounts", async (route) => json(route, []));
  await page.route("**/api/oauth/google/status", async (route) => json(route, { configured: false }));

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connect your email" })).toBeVisible();
  await page.getByRole("button", { name: "Connect account" }).click();
  await expect(page.getByRole("heading", { name: "Connect a mailbox" })).toBeVisible();
  await expect(page.getByText(/demo/i)).toHaveCount(0);
});
