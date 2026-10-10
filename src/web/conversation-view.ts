import type { MessageSummary } from "../shared/contracts";
import { messageKey, messageMatchesKey } from "./mail-view";

/** The opened list row stands in for its own conversation entry so actions keep using the list's location. */
export function conversationThread<T extends MessageSummary>(opened: T, members: readonly T[] | undefined): T[] {
  const index = members?.findIndex((member) => messageMatchesKey(opened, messageKey(member))) ?? -1;
  if (!members || index < 0) return [opened];
  return members.map((member, position) => position === index ? opened : member);
}

export function initiallyExpanded(thread: readonly MessageSummary[], opened: MessageSummary): Set<string> {
  return new Set(thread.filter((message) => message === opened || !message.read).map(messageKey));
}
