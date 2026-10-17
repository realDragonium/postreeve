import type { Account, Folder } from "../shared/contracts";

export type PurgeableUse = "trash" | "junk";

/** The Trash or Spam folder at `path`, which is the only place permanent delete is offered. */
export function purgeableFolder(folders: readonly Folder[], path: string): (Folder & { specialUse: PurgeableUse }) | null {
  const folder = folders.find((candidate) => candidate.path === path);
  return folder && (folder.specialUse === "trash" || folder.specialUse === "junk")
    ? folder as Folder & { specialUse: PurgeableUse }
    : null;
}

/** Gmail's delete endpoints need a broader grant than Postreeve asks for; see GMAIL_PERMANENT_DELETE_UNAVAILABLE. */
export function canDeletePermanently(account: Pick<Account, "kind"> | undefined): boolean {
  return account?.kind === "imap";
}

export function emptyLabel(use: PurgeableUse): string {
  return use === "trash" ? "Empty Trash" : "Empty Spam";
}

export function messageCount(count: number): string {
  return `${count} message${count === 1 ? "" : "s"}`;
}
