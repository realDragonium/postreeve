import { expect, test, type Route } from "@playwright/test";
import { canonicalMessageSummarySchema, type Account, type CanonicalMessageDetail, type Folder } from "../../src/shared/contracts";
import type { MailboxEvent } from "../../src/shared/mailbox-events";

const account: Account = { id: "account-work", name: "Work inbox", email: "alex@example.com", kind: "imap" };
const folders: Folder[] = [{ path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 1, total: 1 }];

function detail(uid: number, subject: string): CanonicalMessageDetail {
  return {
    attachments: [], canonicalId: `canonical-${uid}`, canonicalAliases: [], conversationId: `conversation-${uid}`,
    ref: { accountId: account.id, mailbox: "INBOX", uidValidity: "22", uid, modseq: null },
    messageId: `${uid}@example.com`, subject, from: [{ name: "Sam Rivera", address: "sam@example.com" }],
    to: [{ name: "Alex", address: account.email }], receivedAt: `2026-10-10T0${uid}:00:00.000Z`,
    preview: `Preview of message ${uid}`, read: false, flagged: false, text: subject, html: `<p>${subject}</p>`,
  };
}
const existing = detail(1, "Quarterly planning notes");
const arrived = detail(2, "Lunch on Friday?");

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

test("pushes new mail into the open list and opens it from a desktop notification", async ({ page }) => {
  await page.addInitScript(() => {
    const created: Array<{ title: string; body: string; tag: string; onclick: (() => void) | null }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static async requestPermission(): Promise<NotificationPermission> {
        FakeNotification.permission = "granted";
        return "granted";
      }
      onclick: (() => void) | null = null;
      readonly body: string;
      readonly tag: string;
      constructor(readonly title: string, options: NotificationOptions) {
        this.body = options.body ?? "";
        this.tag = options.tag ?? "";
        created.push(this);
      }
      close(): void {}
    }
    Object.assign(window, { Notification: FakeNotification, createdNotifications: created });
    document.hasFocus = () => false;
  });

  // React StrictMode opens and abandons a first stream, so only the most recent held stream receives the events.
  const heldStreams: Route[] = [];
  let delivered = false;
  let listRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/events") {
      if (!delivered) heldStreams.push(route);
      else await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": connected\n\n" });
      return;
    }
    if (url.pathname === "/api/accounts") return json(route, [account]);
    if (url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (url.pathname === "/api/synchronization") return json(route, { accounts: [], retention: { maxAgeDays: 30, maxContentBytes: 1 } });
    if (url.pathname === `/api/accounts/${account.id}/folders`) return json(route, folders);
    if (url.pathname === "/api/messages/query") {
      listRequests++;
      const messages = delivered ? [arrived, existing] : [existing];
      return json(route, { messages: canonicalMessageSummarySchema.array().parse(messages), nextCursor: null,
        coverage: { sources: [], complete: true, bodyTextLimit: 32768 } });
    }
    if (url.pathname === "/api/messages/read") return json(route, [arrived]);
    if (url.pathname === "/api/proposals" || url.pathname === "/api/batches" || url.pathname.endsWith("/drafts")) return json(route, []);
    return json(route, { error: `Unhandled test route: ${request.method()} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await expect(page.getByText(existing.subject, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Mailbox", exact: true }).click();
  const requestsBeforePush = listRequests;

  delivered = true;
  const events: MailboxEvent[] = [
    { type: "mailbox-changed", accountId: account.id },
    { type: "new-mail", accountId: account.id, arrivals: [{ canonicalId: arrived.canonicalId, mailbox: "INBOX",
      sender: "Sam Rivera", subject: arrived.subject, receivedAt: arrived.receivedAt }] },
  ];
  const live = heldStreams.pop()!;
  for (const abandoned of heldStreams) await abandoned.abort().catch(() => undefined);
  await live.fulfill({ status: 200, contentType: "text/event-stream",
    body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
  await expect(page.getByText(arrived.subject, { exact: true })).toBeVisible();
  expect(listRequests).toBeGreaterThan(requestsBeforePush);
  const notifications = await page.evaluate(() =>
    (window as unknown as { createdNotifications: Array<{ title: string; body: string; tag: string }> }).createdNotifications
      .map(({ title, body, tag }) => ({ title, body, tag })));
  expect(notifications).toEqual([{ title: "Sam Rivera", body: `${arrived.subject}\n${account.email}`, tag: arrived.canonicalId }]);

  await page.evaluate(() =>
    (window as unknown as { createdNotifications: Array<{ onclick: (() => void) | null }> }).createdNotifications[0]?.onclick?.());
  await expect(page.getByRole("heading", { name: arrived.subject })).toBeVisible();
});
