import { expect, test, type Page, type Route } from "@playwright/test";
import {
  createAccountInputSchema,
  directActionInputSchema,
  messageSummarySchema,
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
  html: "<p>Here are the <strong>decisions</strong> and follow-ups.</p><img src=\"https://tracker.invalid/pixel.gif\"><script>window.compromised=true</script>",
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

  await installWebMcpHarness(page);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/folders`) {
      folderRequests += 1;
      return json(route, folders);
    }
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/messages`) {
      messageRequests += 1;
      lastMessageQuery = url.searchParams.get("query") ?? "";
      return json(route, [message]);
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
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByLabel("Filter messages")).toHaveValue("all");
  await expect(page.getByLabel("Sort messages")).toHaveValue("newest");
  await expect(page.getByRole("button", { name: "Refresh mailbox" })).toBeVisible();
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
  await expect(page.getByLabel("Filter messages")).toHaveValue("unread");
  await expect(page.getByLabel("Sort messages")).toHaveValue("oldest");
  await expect(page.getByText("Results for “quarterly planning”")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("WebMCP updated the visible mailbox view.");
  await page.getByRole("button", { name: "Identities", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Identities" })).toBeVisible();
  await page.getByRole("button", { name: "Close identities panel" }).click();
  await page.getByRole("button", { name: "Manage folders" }).click();
  await expect(page.getByRole("heading", { name: "Manage folders" })).toBeVisible();
  await page.getByRole("button", { name: "Close folder panel" }).click();
  const initialFolderRequests = folderRequests;
  await page.clock.fastForward(15_000);
  await expect.poll(() => folderRequests).toBeGreaterThan(initialFolderRequests);

  await page.getByRole("button", { name: "Compose" }).click();
  await expect(page.getByLabel("From identity")).toHaveValue("alex@example.com");
  await page.getByLabel("To", { exact: true }).fill("jordan@example.com, taylor@example.com");
  await page.getByLabel("Cc", { exact: true }).fill("team@example.com");
  await page.getByLabel("Subject", { exact: true }).fill("Planning follow-up");
  await page.getByLabel("Message", { exact: true }).fill("Here are the next steps from our planning session.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "Message sent", level: 2 })).toBeVisible();
  expect(sentMessage).toMatchObject({ accountId: account.id, subject: "Planning follow-up", text: "Here are the next steps from our planning session." });
  await expect.poll(() => messageRequests).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByRole("button", { name: "Compose" }).click();
  await page.getByLabel("Subject", { exact: true }).fill("Locally saved idea");
  await page.getByLabel("Message", { exact: true }).fill("Keep this as a draft for now.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Local drafts/ }).click();
  await expect(page.getByText("Locally saved idea", { exact: true })).toBeVisible();
  await page.getByText("Locally saved idea", { exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this as a draft for now.");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByText("Quarterly planning notes", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Quarterly planning notes" })).toBeVisible();
  await expect(page.getByText("delivered to planning-alias@example.com", { exact: true })).toBeVisible();
  await expect(page.getByText("Remote images blocked to protect your privacy.")).toBeVisible();
  await expect(page.locator(".email-html img")).not.toHaveAttribute("src");
  await expect(page.locator(".email-html script")).toHaveCount(0);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("sam@example.com");
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("Re: Quarterly planning notes");
  await expect(page.getByText("Frontend ready, backend pending.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByLabel("Move destination").selectOption("Archive");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Moved to Archive.");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByText("Move to folder", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo supported actions" }).click();
  await expect(page.locator(".status-pill", { hasText: "undone" })).toBeVisible();
});

test("opens and closes the reading pane on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (request.method() === "GET" && url.pathname === `/api/accounts/${account.id}/folders`) return json(route, folders);
    if (request.method() === "GET" && url.pathname === `/api/accounts/${account.id}/messages`) return json(route, [message]);
    if (request.method() === "POST" && url.pathname === "/api/messages/read") return json(route, [message]);
    return json(route, { error: `Unhandled test route: ${request.method()} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await page.getByText(message.subject, { exact: true }).click();
  await expect(page.getByRole("heading", { name: message.subject })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to messages" })).toBeVisible();
  await page.getByRole("button", { name: "Back to messages" }).click();
  await expect(page.getByRole("heading", { name: message.subject })).toBeHidden();
  await expect(page.getByText(message.subject, { exact: true })).toBeVisible();
});

test("shows and selects a newly connected account without a reload", async ({ page }) => {
  const personal: Account = {
    id: "account-personal",
    name: "Personal",
    email: "person@example.com",
    kind: "imap",
  };
  const work: Account = {
    id: "account-new-work",
    name: "New work",
    email: "person@work.example",
    kind: "imap",
  };
  let created = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET" && url.pathname === "/api/accounts") return json(route, created ? [personal, work] : [personal]);
    if (method === "POST" && url.pathname === "/api/accounts") {
      createAccountInputSchema.parse(request.postDataJSON());
      created = true;
      return json(route, work, 201);
    }
    if (method === "GET" && url.pathname.endsWith("/folders")) {
      return json(route, [{ path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 0, total: 0 }]);
    }
    if (method === "GET" && url.pathname.endsWith("/messages")) return json(route, []);
    return json(route, { error: `Unhandled test route: ${method} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByLabel("Name", { exact: true }).fill(work.name);
  await page.getByLabel("Email address").fill(work.email);
  await page.getByLabel("IMAP host").fill("imap.work.example");
  await page.getByLabel("Username").first().fill(work.email);
  await page.getByLabel(/Password/).first().fill("incoming-password");
  await page.getByRole("button", { name: "Connect account" }).click();

  const picker = page.getByLabel("Email account");
  await expect(picker.locator("option", { hasText: `${work.name} · ${work.email}` })).toHaveCount(1);
  await expect(picker).toHaveValue(work.id);
  await expect(page.getByText(work.email, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("starts with real account onboarding when no mailbox is connected", async ({ page }) => {
  await page.route("**/api/accounts", async (route) => json(route, []));

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Connect your email" })).toBeVisible();
  await expect(page.getByText("No account connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect account" }).click();
  await expect(page.getByRole("heading", { name: "Connect a mailbox" })).toBeVisible();
  await expect(page.getByText(/demo/i)).toHaveCount(0);
});
