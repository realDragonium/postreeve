import { z } from "zod";
import type { MailboxEvent } from "../shared/mailbox-events";

const storageKey = "postreeve.notifications.v1";
const preferencesSchema = z.object({ enabled: z.boolean(), mutedAccountIds: z.array(z.string()) });
export type NotificationPreferences = z.infer<typeof preferencesSchema>;
export const defaultNotificationPreferences: NotificationPreferences = { enabled: false, mutedAccountIds: [] };

/** More arrivals than this from one event collapse into one summary notification. */
const individualLimit = 3;

export function loadNotificationPreferences(storage: Pick<Storage, "getItem">): NotificationPreferences {
  try {
    const parsed = preferencesSchema.safeParse(JSON.parse(storage.getItem(storageKey) ?? "null"));
    return parsed.success ? parsed.data : defaultNotificationPreferences;
  } catch {
    return defaultNotificationPreferences;
  }
}

export function storeNotificationPreferences(storage: Pick<Storage, "setItem">, preferences: NotificationPreferences): void {
  try {
    storage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // The choice applies to this session only when storage is unavailable.
  }
}

export type NotificationAccess = NotificationPermission | "unsupported";

export interface PlannedNotification {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly open: { readonly accountId: string; readonly mailbox: string; readonly canonicalId: string | null };
}

export function notificationsFor(
  event: MailboxEvent,
  preferences: NotificationPreferences,
  context: { readonly access: NotificationAccess; readonly focused: boolean; readonly accountLabel: string },
): PlannedNotification[] {
  if (event.type !== "new-mail" || !preferences.enabled || context.access !== "granted" || context.focused
    || preferences.mutedAccountIds.includes(event.accountId)) return [];
  const { accountId, arrivals } = event;
  if (arrivals.length > individualLimit) {
    return [{ title: `${arrivals.length} new messages`, body: context.accountLabel, tag: `new-mail:${accountId}`,
      open: { accountId, mailbox: arrivals[0]!.mailbox, canonicalId: null } }];
  }
  return arrivals.map(arrival => ({
    title: arrival.sender || context.accountLabel,
    body: [arrival.subject || "(no subject)", context.accountLabel].join("\n"),
    tag: arrival.canonicalId,
    open: { accountId, mailbox: arrival.mailbox, canonicalId: arrival.canonicalId },
  }));
}
