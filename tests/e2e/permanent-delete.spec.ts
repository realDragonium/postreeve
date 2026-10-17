import { expect, test, type Page, type Route } from "@playwright/test";
import { mailboxQuerySchema } from "../../src/shared/mailbox-query";
import { canonicalMessageSummarySchema, type Account, type CanonicalMessageDetail, type Folder } from "../../src/shared/contracts";

const imap: Account = { id: "account-imap", name: "Work", email: "alex@example.com", kind: "imap" };
const gmail: Account = { id: "account-gmail", name: "Personal", email: "alex@gmail.test", kind: "gmail" };
const imapFolders: Folder[] = [
  { path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 0, total: 0 },
  { path: "Bin", name: "Bin", specialUse: "trash", unread: 0, total: 2 },
];
const gmailFolders: Folder[] = [
  { path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 0, total: 0 },
  { path: "TRASH", name: "Trash", specialUse: "trash", unread: 0, total: 1 },
];

function trashed(uid: number, subject: string): CanonicalMessageDetail {
  return {
    attachments: [], canonicalId: `canonical-${uid}`, canonicalAliases: [], conversationId: `conversation-${uid}`,
    ref: { accountId: imap.id, mailbox: "Bin", uidValidity: "7", uid, modseq: "3" },
    messageId: `${uid}@example.com`, subject, from: [{ name: "Sender", address: "sender@example.com" }],
    to: [{ name: "Alex", address: imap.email }], receivedAt: "2026-08-29T08:30:00.000Z", preview: "Old mail",
    read: true, flagged: false, text: "Old mail", html: null,
  };
}
const old = trashed(5, "Old newsletter");
const older = trashed(6, "Older receipt");

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function mock(page: Page) {
  const requests: { path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const method = request.method();
    if (path === "/api/events") return route.abort();
    if (method === "GET" && path === "/api/accounts") return json(route, [imap, gmail]);
    if (method === "GET" && path === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "GET" && path === `/api/accounts/${imap.id}/folders`) return json(route, imapFolders);
    if (method === "GET" && path === `/api/accounts/${gmail.id}/folders`) return json(route, gmailFolders);
    if (method === "GET" && /\/(identities|signatures|drafts)$/.test(path)) return json(route, []);
    if (method === "POST" && path === "/api/messages/query") {
      const query = mailboxQuerySchema.parse(request.postDataJSON());
      const imapTrash = query.sources.some(({ accountId, mailbox }) => accountId === imap.id && mailbox === "Bin");
      return json(route, { messages: canonicalMessageSummarySchema.array().parse(imapTrash ? [old, older] : []), nextCursor: null,
        coverage: { sources: [], complete: true, bodyTextLimit: 32768 } });
    }
    if (method === "POST" && path === "/api/messages/read") return json(route, [old]);
    if (method === "GET" && path.startsWith("/api/conversations/")) return json(route, []);
    if (method === "POST" && (path === "/api/messages/delete-permanently" || path.endsWith("/folders/empty"))) {
      requests.push({ path, body: request.postDataJSON() });
      return json(route, { deleted: path.endsWith("/empty") ? 2 : 1 });
    }
    if (method === "GET" && (path === "/api/proposals" || path === "/api/batches")) return json(route, []);
    return json(route, { error: `Unhandled test route: ${method} ${path}` }, 404);
  });
  return requests;
}

test("deletes a trashed message and empties Trash only after confirmation", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^alex@example\.com/ }).click();
  await page.getByRole("button", { name: /^Bin\b/ }).click();
  await page.getByText("Old newsletter", { exact: true }).click();

  await page.getByRole("button", { name: "Delete forever" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete 1 message forever?" });
  await expect(dialog).toContainText("“Old newsletter” will be deleted from Bin on the mail server.");
  await expect(dialog).toContainText("This cannot be undone.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Enter on the focused Cancel button must not delete.
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(requests).toEqual([]);

  await page.getByRole("button", { name: "Delete forever" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete forever" }).click();
  await expect(page.getByText("Deleted 1 message permanently", { exact: true })).toBeVisible();
  expect(requests).toEqual([{ path: "/api/messages/delete-permanently", body: {
    accountId: imap.id, messages: [old.ref], confirm: "delete permanently",
  } }]);
  // Permanent deletes have no undo entry.
  await expect(page.getByRole("button", { name: "Undo ⌘Z" })).toHaveCount(0);

  await page.getByRole("region", { name: "Permanent delete" }).getByRole("button", { name: "Empty Trash" }).click();
  const empty = page.getByRole("alertdialog", { name: "Empty Trash?" });
  await expect(empty).toContainText("Every message in Trash for alex@example.com");
  await empty.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.getByText("Deleted 2 messages permanently", { exact: true })).toBeVisible();
  expect(requests.at(-1)).toEqual({ path: `/api/accounts/${imap.id}/folders/empty`, body: { path: "Bin", confirm: "delete permanently" } });
});

test("Gmail Trash explains Gmail's own removal and offers no permanent delete", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^alex@gmail\.test/ }).click();
  await page.getByRole("button", { name: /^Trash\b/ }).click();
  const strip = page.getByRole("region", { name: "Permanent delete" });
  await expect(strip).toContainText("Gmail removes messages from Trash after 30 days.");
  await expect(strip.getByRole("button")).toHaveCount(0);
  expect(requests).toEqual([]);
});
