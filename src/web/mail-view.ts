import type { Folder, MessageSummary } from "../shared/contracts";
import type { MessageFilter, MessageSort } from "./mail-ui-state";

export type SpecialUse = NonNullable<Folder["specialUse"]>;

/** The unified sidebar offers one row per special-use folder, in reading order. */
export const unifiedSpecialUses: readonly SpecialUse[] = ["inbox", "archive", "sent", "drafts", "junk", "trash"];

const specialUseNames: Record<SpecialUse, string> = {
  inbox: "Inbox",
  archive: "Archive",
  sent: "Sent",
  drafts: "Drafts",
  junk: "Spam",
  trash: "Trash",
};

export function specialUseName(specialUse: SpecialUse): string {
  return specialUseNames[specialUse];
}

/**
 * Where the message list reads from. Unified fans the same special-use folder
 * out across every connected account; account scope names one concrete path.
 */
export type Scope =
  | { readonly kind: "unified"; readonly specialUse: SpecialUse }
  | { readonly kind: "account"; readonly accountId: string; readonly path: string };

export function scopeKey(scope: Scope): string {
  return scope.kind === "unified" ? `unified:${scope.specialUse}` : `account:${scope.accountId}:${scope.path}`;
}

export function scopeGroupId(scope: Scope): string {
  return scope.kind === "unified" ? "unified" : scope.accountId;
}

/** The account/folder pairs a scope has to query to fill the list. */
export function scopeSources(
  scope: Scope,
  foldersByAccount: ReadonlyMap<string, readonly Folder[]>,
): readonly { readonly accountId: string; readonly mailbox: string }[] {
  if (scope.kind === "account") return [{ accountId: scope.accountId, mailbox: scope.path }];
  return [...foldersByAccount].flatMap(([accountId, folders]) =>
    folders
      .filter((folder) => folder.specialUse === scope.specialUse)
      .map((folder) => ({ accountId, mailbox: folder.path })));
}

export interface UnifiedFolder {
  readonly specialUse: SpecialUse;
  readonly name: string;
  readonly unread: number;
  readonly total: number;
}

/** Sums each special-use folder across accounts so the unified rows carry real counts. */
export function unifiedFolders(foldersByAccount: ReadonlyMap<string, readonly Folder[]>): UnifiedFolder[] {
  return unifiedSpecialUses
    .map((specialUse) => {
      const matches = [...foldersByAccount.values()].flat().filter((folder) => folder.specialUse === specialUse);
      return {
        specialUse,
        name: specialUseNames[specialUse],
        unread: matches.reduce((total, folder) => total + folder.unread, 0),
        total: matches.reduce((total, folder) => total + folder.total, 0),
      };
    })
    .filter((folder) => folder.total > 0 || folder.specialUse === "inbox");
}

export function messageKey(message: MessageSummary): string {
  return message.canonicalId ?? `${message.ref.accountId}:${message.ref.mailbox}:${message.ref.uidValidity}:${message.ref.uid}`;
}

export function messageIdentityKeys(message: MessageSummary): readonly string[] {
  return [messageKey(message), ...(message.canonicalAliases ?? [])];
}

export function messageMatchesKey(message: MessageSummary, key: string | null): boolean {
  return key !== null && messageIdentityKeys(message).includes(key);
}

export function messageIsSelected(message: MessageSummary, selected: ReadonlySet<string>): boolean {
  return messageIdentityKeys(message).some((key) => selected.has(key));
}

export function senderName(message: MessageSummary): string {
  const first = message.from[0];
  return first?.name || first?.address || "Unknown sender";
}

export function filterMessages(messages: readonly MessageSummary[], filter: MessageFilter): MessageSummary[] {
  if (filter === "unread") return messages.filter((message) => !message.read);
  if (filter === "flagged") return messages.filter((message) => message.flagged);
  return [...messages];
}

export function sortMessages(messages: readonly MessageSummary[], sort: MessageSort): MessageSummary[] {
  const sorted = [...messages];
  if (sort === "oldest") return sorted.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
  if (sort === "sender") return sorted.sort((left, right) => senderName(left).localeCompare(senderName(right)));
  if (sort === "subject") return sorted.sort((left, right) => left.subject.localeCompare(right.subject));
  return sorted.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

interface MessageIdentityGroup {
  readonly message: MessageSummary;
  readonly identities: ReadonlySet<string>;
}

function mergeIdentityGroups(
  groups: readonly MessageIdentityGroup[],
  message: MessageSummary,
): MessageIdentityGroup[] {
  const incomingIdentities = messageIdentityKeys(message);
  const matched = groups
    .map((group, index) => incomingIdentities.some((identity) => group.identities.has(identity)) ? index : -1)
    .filter((index) => index >= 0);
  if (matched.length === 0) {
    return [...groups, { message, identities: new Set(incomingIdentities) }];
  }

  const identities = new Set<string>();
  const candidates: MessageSummary[] = [];
  for (const index of matched) {
    const group = groups[index]!;
    for (const identity of group.identities) identities.add(identity);
    candidates.push(group.message);
  }
  for (const identity of incomingIdentities) identities.add(identity);
  candidates.push(message);

  const aliases = new Set(candidates.flatMap((candidate) => candidate.canonicalAliases ?? []));
  const representative = candidates.find((candidate) => !aliases.has(messageKey(candidate))) ?? candidates[0]!;
  const canonicalAliases = [...identities].filter((identity) => identity !== messageKey(representative));
  const currentAliases = representative.canonicalAliases ?? [];
  const coherentRepresentative = currentAliases.length === canonicalAliases.length
      && currentAliases.every((alias, index) => alias === canonicalAliases[index])
    ? representative
    : { ...representative, canonicalAliases };

  const first = matched[0]!;
  const matchedSet = new Set(matched);
  return groups.flatMap((group, index) => {
    if (index === first) return [{ message: coherentRepresentative, identities }];
    return matchedSet.has(index) ? [] : [group];
  });
}

/** Merges per-account results by every known canonical identity and alias. */
export function mergeMessages(lists: readonly (readonly MessageSummary[])[]): MessageSummary[] {
  return lists.flat().reduce<MessageIdentityGroup[]>(mergeIdentityGroups, []).map(({ message }) => message);
}

export function countLine(
  messages: readonly MessageSummary[],
  options: { readonly query: string; readonly filter: MessageFilter; readonly awaiting: number },
): string {
  const parts = [
    `${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
    `${messages.filter((message) => !message.read).length} unread`,
  ];
  if (options.awaiting > 0) parts.push(`${options.awaiting} awaiting you`);
  if (options.query) parts.push(`matching “${options.query}”`);
  if (options.filter !== "all") parts.push(`${options.filter} only`);
  return parts.join(" · ");
}
