import { expect, test, type Route } from "@playwright/test";
import {
  canonicalMessageSummarySchema,
  createDraftInputSchema,
  createIdentityInputSchema,
  type Account,
  type CanonicalMessageDetail,
  type CreateDraftInput,
  type Draft,
  type Folder,
  type Identity,
} from "../../src/shared/contracts";

const account: Account = { id: "account-work", name: "Work inbox", email: "alex@example.com", kind: "imap" };
const folders: Folder[] = [{ path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 1, total: 1 }];
const message: CanonicalMessageDetail = {
  attachments: [],
  canonicalId: "canonical-message",
  canonicalAliases: [],
  conversationId: "conversation-message",
  ref: { accountId: account.id, mailbox: "INBOX", uidValidity: "22", uid: 41, modseq: "8" },
  messageId: "<message@example.com>",
  subject: "Partnership enquiry",
  from: [{ name: "Sam Rivera", address: "sam@example.com" }],
  to: [{ name: "Sales", address: "sales@example.com" }, { name: "Alex", address: account.email }],
  deliveredTo: ["sales@example.com"],
  receivedAt: "2026-08-29T08:30:00.000Z",
  preview: "Can we talk?",
  read: false,
  flagged: false,
  text: "Can we talk?",
  html: null,
};

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

test("migrates local identities and replies from the alias the message was delivered to", async ({ page }) => {
  let identities: Identity[] = [];
  const createdDrafts: CreateDraftInput[] = [];
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("postreeve.local-identities.v1", JSON.stringify([
      { id: "local-sales", accountId: "account-work", name: "Sales desk", email: "sales@example.com" },
    ]));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET" && url.pathname === "/api/accounts") return json(route, [account]);
    if (method === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/folders`) return json(route, folders);
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/drafts`) return json(route, []);
    if (method === "POST" && url.pathname === "/api/messages/query") {
      return json(route, { messages: canonicalMessageSummarySchema.array().parse([message]), nextCursor: null,
        coverage: { sources: [], complete: true, bodyTextLimit: 32768 } });
    }
    if (method === "POST" && url.pathname === "/api/messages/read") return json(route, [message]);
    if (method === "GET" && url.pathname === `/api/accounts/${account.id}/identities`) return json(route, identities);
    if (method === "POST" && url.pathname === `/api/accounts/${account.id}/identities`) {
      const input = createIdentityInputSchema.parse(request.postDataJSON());
      const identity: Identity = { id: `identity-${identities.length + 1}`, accountId: account.id, ...input, createdAt: "2026-08-29T09:00:00.000Z" };
      identities = [...identities, identity];
      return json(route, identity, 201);
    }
    const removal = new RegExp(`^/api/accounts/${account.id}/identities/([^/]+)$`).exec(url.pathname);
    if (method === "DELETE" && removal) {
      identities = identities.filter(({ id }) => id !== removal[1]);
      return json(route, { ok: true });
    }
    if (method === "POST" && url.pathname === `/api/accounts/${account.id}/drafts`) {
      const input = createDraftInputSchema.parse({ accountId: account.id, ...request.postDataJSON() });
      createdDrafts.push(input);
      const { clientId, ...content } = input;
      const draft: Draft = {
        ...content,
        id: clientId ?? "draft-1",
        delivery: { status: "editable" },
        mirror: { status: "pending" },
        createdAt: "2026-08-29T09:00:00.000Z",
        updatedAt: "2026-08-29T09:00:00.000Z",
        version: 1,
      };
      return json(route, draft, 201);
    }
    if (method === "GET" && url.pathname === "/api/proposals") return json(route, []);
    if (method === "GET" && url.pathname === "/api/batches") return json(route, []);
    return json(route, { error: `Unhandled test route: ${method} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await expect.poll(() => identities.map(({ address }) => address)).toEqual(["sales@example.com"]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("postreeve.local-identities.migrated.v1"))).toBe("complete");

  await page.getByText(message.subject, { exact: true }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("From identity")).toHaveValue("sales@example.com");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("sam@example.com");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => createdDrafts.at(-1)?.identity).toEqual({ name: "Sales desk", address: "sales@example.com" });
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.getByRole("button", { name: "Close Reply" }).click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Identities" }).click();
  await page.getByLabel("Identity name").fill("Support");
  await page.getByLabel("Identity email address").fill("Support@Example.com");
  await page.getByRole("button", { name: "Add identity" }).click();
  await expect(page.getByText("support@example.com", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove identity sales@example.com" }).click();
  await expect(page.getByText("sales@example.com", { exact: true })).toHaveCount(0);
  expect(identities.map(({ address }) => address)).toEqual(["support@example.com"]);
});
