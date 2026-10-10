import { describe, expect, test } from "bun:test";
import type { MailboxEvent, NewMailArrival } from "../src/shared/mailbox-events";
import {
  defaultNotificationPreferences,
  loadNotificationPreferences,
  notificationsFor,
  storeNotificationPreferences,
} from "../src/web/notifications";

const arrival = (id: string): NewMailArrival => ({ canonicalId: id, mailbox: "INBOX", sender: "Ada", subject: `Hello ${id}`, receivedAt: "2026-10-10T08:00:00.000Z" });
const event = (count: number): MailboxEvent => ({ type: "new-mail", accountId: "a", arrivals: Array.from({ length: count }, (_, index) => arrival(`m${index}`)) });
const enabled = { enabled: true, mutedAccountIds: [] };
const context = { access: "granted" as const, focused: false, accountLabel: "me@example.test" };

describe("notification decisions", () => {
  test("one notification per arrival that opens the message", () => {
    expect(notificationsFor(event(2), enabled, context)).toEqual([
      { title: "Ada", body: "Hello m0\nme@example.test", tag: "m0", open: { accountId: "a", mailbox: "INBOX", canonicalId: "m0" } },
      { title: "Ada", body: "Hello m1\nme@example.test", tag: "m1", open: { accountId: "a", mailbox: "INBOX", canonicalId: "m1" } },
    ]);
  });

  test("a burst becomes one summary that opens the Inbox", () => {
    expect(notificationsFor(event(5), enabled, context)).toEqual([
      { title: "5 new messages", body: "me@example.test", tag: "new-mail:a", open: { accountId: "a", mailbox: "INBOX", canonicalId: null } },
    ]);
  });

  test("disabled, muted, unpermitted, focused and change events show nothing", () => {
    expect(notificationsFor(event(1), defaultNotificationPreferences, context)).toEqual([]);
    expect(notificationsFor(event(1), { enabled: true, mutedAccountIds: ["a"] }, context)).toEqual([]);
    expect(notificationsFor(event(1), enabled, { ...context, access: "denied" })).toEqual([]);
    expect(notificationsFor(event(1), enabled, { ...context, focused: true })).toEqual([]);
    expect(notificationsFor({ type: "mailbox-changed", accountId: "a" }, enabled, context)).toEqual([]);
  });

  test("preferences round-trip and default to off when unreadable", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(loadNotificationPreferences(storage)).toEqual(defaultNotificationPreferences);
    storeNotificationPreferences(storage, { enabled: true, mutedAccountIds: ["a"] });
    expect(loadNotificationPreferences(storage)).toEqual({ enabled: true, mutedAccountIds: ["a"] });
    values.set("postreeve.notifications.v1", "{broken");
    expect(loadNotificationPreferences(storage)).toEqual(defaultNotificationPreferences);
  });
});
