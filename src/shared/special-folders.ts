import type { Folder, FolderMappings, SpecialFolderRole } from "./contracts";

export type SpecialUseSource = NonNullable<Folder["specialUseSource"]>;

/**
 * Common folder names per role, most specific first. Hosts without SPECIAL-USE (cPanel, older Dovecot,
 * some Exchange) name these folders in the mailbox owner's language.
 */
const knownNames: Record<SpecialFolderRole, readonly string[]> = {
  sent: [
    "sent", "sent items", "sent mail", "sent messages", "verzonden", "verzonden items", "gesendet",
    "gesendete objekte", "gesendete elemente", "envoyés", "éléments envoyés", "messages envoyés", "enviados",
    "elementos enviados", "itens enviados", "inviata", "posta inviata", "skickat", "skickade objekt", "sendt",
    "sendte elementer",
  ],
  drafts: [
    "drafts", "draft", "concepten", "concept", "entwürfe", "brouillons", "borradores", "rascunhos", "bozze",
    "utkast", "kladder",
  ],
  trash: [
    "trash", "deleted items", "deleted messages", "deleted", "bin", "prullenbak", "verwijderde items",
    "papierkorb", "gelöschte elemente", "gelöschte objekte", "corbeille", "éléments supprimés", "papelera",
    "elementos eliminados", "lixeira", "itens excluídos", "cestino", "papperskorgen", "borttagna objekt",
    "papirkurv", "slettede elementer",
  ],
  junk: [
    "junk", "junk e-mail", "junk email", "junk mail", "spam", "bulk mail", "ongewenste e-mail", "ongewenst",
    "spamverdacht", "junk-e-mail", "courrier indésirable", "indésirables", "correo no deseado",
    "lixo eletrônico", "posta indesiderata", "skräppost",
  ],
  archive: ["archive", "archives", "archived", "archief", "archiv", "archivo", "archivio", "arquivo", "arkiv"],
};

export interface MailboxCandidate {
  readonly path: string;
  readonly name: string;
  /** The parent path, empty for a top-level mailbox. */
  readonly parentPath: string;
  /** The role the server's SPECIAL-USE attribute (or the INBOX path) gives the mailbox. */
  readonly flagged: Folder["specialUse"];
}

export interface ResolvedSpecialUse {
  readonly specialUse: Folder["specialUse"];
  readonly specialUseSource: Folder["specialUseSource"];
}

/** The role a folder name suggests, and the name's rank within that role (lower is better). */
export function specialUseFromName(name: string): { role: SpecialFolderRole; rank: number } | null {
  const normalized = name.normalize("NFC").trim().toLowerCase();
  for (const [role, names] of Object.entries(knownNames) as Array<[SpecialFolderRole, readonly string[]]>) {
    const rank = names.indexOf(normalized);
    if (rank >= 0) return { role, rank };
  }
  return null;
}

/** Owner overrides win over SPECIAL-USE attributes, which win over folder names. */
export function resolveSpecialUses(
  mailboxes: readonly MailboxCandidate[],
  overrides: FolderMappings,
): Map<string, ResolvedSpecialUse> {
  const resolved = new Map<string, ResolvedSpecialUse>();
  const listed = new Set(mailboxes.map(({ path }) => path));
  const inbox = mailboxes.find(({ flagged }) => flagged === "inbox")?.path;
  const overridden = new Map<SpecialFolderRole, string | null>();
  for (const [role, path] of Object.entries(overrides) as Array<[SpecialFolderRole, string | null | undefined]>) {
    if (path === undefined) continue;
    if (path === null) overridden.set(role, null);
    else if (listed.has(path) && path !== inbox) overridden.set(role, path);
  }
  for (const [role, path] of overridden) {
    if (path !== null) resolved.set(path, { specialUse: role, specialUseSource: "override" });
  }
  for (const mailbox of mailboxes) {
    if (resolved.has(mailbox.path) || mailbox.flagged === null) continue;
    if (mailbox.flagged !== "inbox" && overridden.has(mailbox.flagged)) continue;
    resolved.set(mailbox.path, { specialUse: mailbox.flagged, specialUseSource: "special-use" });
  }
  const taken = new Set([...resolved.values()].map(({ specialUse }) => specialUse));
  const best = new Map<SpecialFolderRole, { path: string; rank: number }>();
  for (const mailbox of mailboxes) {
    if (resolved.has(mailbox.path) || !nameEligible(mailbox)) continue;
    const match = specialUseFromName(mailbox.name);
    if (!match || taken.has(match.role) || overridden.has(match.role)) continue;
    const current = best.get(match.role);
    if (!current || match.rank < current.rank) best.set(match.role, { path: mailbox.path, rank: match.rank });
  }
  for (const [role, { path }] of best) resolved.set(path, { specialUse: role, specialUseSource: "name" });
  return resolved;
}

/** Only top-level folders and direct children of INBOX (cPanel's `INBOX.Sent`) are recognised by name. */
function nameEligible(mailbox: MailboxCandidate): boolean {
  return mailbox.parentPath === "" || mailbox.parentPath.toUpperCase() === "INBOX";
}
