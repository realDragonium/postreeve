import { expect, test, type Page, type Route } from "./support/owner-session";
import {
  canonicalMessageSummarySchema,
  createIdentityInputSchema,
  folderMappingsSchema,
  type Account,
  type CanonicalMessageDetail,
  type Folder,
  type FolderMappings,
  type Identity,
} from "../../src/shared/contracts";

const account: Account = { id: "account-shop", name: "Shop owner", email: "owner@primary.test", kind: "imap" };
const message: CanonicalMessageDetail = {
  attachments: [],
  canonicalId: "canonical-promo",
  canonicalAliases: [],
  conversationId: "conversation-promo",
  ref: { accountId: account.id, mailbox: "INBOX", uidValidity: "1", uid: 7, modseq: "1" },
  messageId: "<promo@example.com>",
  subject: "Question about my order",
  from: [{ name: "Sam Rivera", address: "sam@customer.test" }],
  to: [{ name: "", address: "promo@example.com" }],
  deliveredTo: ["promo@example.com"],
  receivedAt: "2026-10-16T08:30:00.000Z",
  preview: "Where is it?",
  read: false,
  flagged: false,
  text: "Where is it?",
  html: null,
};

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

/** A mocked server for one IMAP account without SPECIAL-USE, whose folder roles follow the stored overrides. */
async function mockServer(page: Page, state: { identities: Identity[]; mappings: FolderMappings }) {
  const folders = (): Folder[] => [
    { path: "INBOX", name: "Inbox", specialUse: "inbox", specialUseSource: "special-use", unread: 1, total: 1 },
    { path: "Old mail", name: "Old mail", specialUse: state.mappings.archive === "Old mail" ? "archive" : null,
      specialUseSource: state.mappings.archive === "Old mail" ? "override" : null, unread: 0, total: 3 },
    { path: "Verzonden", name: "Verzonden", specialUse: "sent", specialUseSource: "name", unread: 0, total: 2 },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const base = `/api/accounts/${account.id}`;
    if (method === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (method === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "GET" && url.pathname === `${base}/folders`) return json(route, folders());
    if (method === "GET" && url.pathname === `${base}/folder-mappings`) return json(route, state.mappings);
    if (method === "PUT" && url.pathname === `${base}/folder-mappings`) {
      state.mappings = folderMappingsSchema.parse(request.postDataJSON());
      return json(route, folders());
    }
    if (method === "GET" && url.pathname === `${base}/drafts`) return json(route, []);
    if (method === "GET" && url.pathname === `${base}/signatures`) return json(route, []);
    if (method === "POST" && url.pathname === "/api/messages/query") {
      return json(route, { messages: canonicalMessageSummarySchema.array().parse([message]), nextCursor: null,
        coverage: { sources: [], complete: true, bodyTextLimit: 32768 } });
    }
    if (method === "POST" && url.pathname === "/api/messages/read") return json(route, [message]);
    if (method === "GET" && url.pathname === `${base}/identities`) return json(route, state.identities);
    if (method === "POST" && url.pathname === `${base}/identities`) {
      const input = createIdentityInputSchema.parse(request.postDataJSON());
      const identity: Identity = { id: `identity-${state.identities.length + 1}`, accountId: account.id, ...input, createdAt: "2026-10-17T09:00:00.000Z" };
      state.identities = [...state.identities, identity];
      return json(route, identity, 201);
    }
    if (method === "GET" && url.pathname === "/api/proposals") return json(route, []);
    if (method === "GET" && url.pathname === "/api/batches") return json(route, []);
    return json(route, { error: `Unhandled test route: ${method} ${url.pathname}` }, 404);
  });
}

test("replies from the exact address a wildcard identity covers", async ({ page }) => {
  await mockServer(page, {
    identities: [{ id: "wildcard", accountId: account.id, name: "Shop", address: "*@example.com", createdAt: "2026-10-17T09:00:00.000Z" }],
    mappings: {},
  });
  await page.goto("/");
  await page.getByText(message.subject, { exact: true }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("From identity")).toHaveValue("promo@example.com");
  await expect(page.getByText("which is not one of your identities")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("adds an unregistered delivered address as an identity from compose", async ({ page }) => {
  const state = { identities: [] as Identity[], mappings: {} };
  await mockServer(page, state);
  await page.goto("/");
  await page.getByText(message.subject, { exact: true }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("From identity")).toHaveValue(account.email);
  await expect(page.getByText("Delivered to promo@example.com, which is not one of your identities.")).toBeVisible();
  await page.getByRole("button", { name: "Add as identity" }).click();
  await expect(page.getByLabel("From identity")).toHaveValue("promo@example.com");
  await expect(page.getByText("which is not one of your identities")).toHaveCount(0);
  expect(state.identities.map(({ name, address }) => [name, address])).toEqual([[account.name, "promo@example.com"]]);
});

test("maps the archive folder in Manage folders", async ({ page }) => {
  const state = { identities: [] as Identity[], mappings: {} as FolderMappings };
  await mockServer(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: "Manage folders" }).click();
  await expect(page.getByRole("article", { name: "Verzonden" })).toContainText("sent · found by name");
  await expect(page.getByLabel("Sent folder")).toHaveValue("\u0000automatic");
  await page.getByLabel("Archive folder").selectOption("Old mail");
  await page.getByLabel("Spam folder").selectOption({ label: "None" });
  await page.getByRole("button", { name: "Save special folders" }).click();
  await expect.poll(() => state.mappings).toEqual({ archive: "Old mail", junk: null });
  await expect(page.getByRole("article", { name: "Old mail" })).toContainText("archive · chosen by you");
  await expect(page.getByRole("button", { name: "Save special folders" })).toBeDisabled();
});
