import type { MessageDetail, MessageSummary, TriageAction } from "../shared/contracts";

export const actionLabels: Record<TriageAction["type"], string> = {
  leave: "left here",
  move: "moved",
  trash: "moved to Trash",
  mark_read: "marked read",
  mark_unread: "marked unread",
};

export function actionLabel(action: TriageAction): string {
  return action.type === "move" ? `moved to ${action.destination}` : actionLabels[action.type];
}

const proposedLabels: Record<TriageAction["type"], string> = {
  leave: "leave here",
  move: "move",
  trash: "move to Trash",
  mark_read: "mark read",
  mark_unread: "mark unread",
};

/** History reads in the past tense; a proposal has not happened yet. */
export function proposedActionLabel(action: TriageAction): string {
  return action.type === "move" ? `move to ${action.destination}` : proposedLabels[action.type];
}

export function formatDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown date";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

/** List columns are narrow: today shows a clock, this week a weekday, older a date. */
export function formatListTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const now = new Date();
  const elapsedDays = (now.valueOf() - date.valueOf()) / 86_400_000;
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  if (elapsedDays < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.valueOf()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return formatDate(value);
}

export function fromAddress(message: MessageSummary): string {
  return message.from[0]?.address ?? "";
}

export function recipients(message: MessageSummary): string {
  return message.to.map((address) => address.name || address.address).join(", ") || "me";
}

export function additionalDeliveryAddresses(message: MessageSummary): string[] {
  const visible = new Set(message.to.map(({ address }) => address.toLowerCase()));
  return (message.deliveredTo ?? []).filter((address) => !visible.has(address.toLowerCase()));
}

export function addressList(addresses: readonly { address: string }[]): string {
  return addresses.map(({ address }) => address).join(", ");
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

export function quotedMessage(message: MessageDetail): string {
  const author = message.from[0]?.name || message.from[0]?.address || "Sender";
  const quoted = message.text.split("\n").map((line) => `> ${line}`).join("\n");
  return `\n\nOn ${formatDate(message.receivedAt, true)}, ${author} wrote:\n${quoted}`;
}

export function formatByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes.toLocaleString()} bytes`;
}
