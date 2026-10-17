/** One row of the shortcut table. The key handler, the help dialog and Settings all read this table. */
export interface ShortcutEntry {
  readonly keys: string;
  readonly description: string;
}

export const shortcutGroups: readonly { readonly title: string; readonly entries: readonly ShortcutEntry[] }[] = [
  {
    title: "Navigate",
    entries: [
      { keys: "j / ↓", description: "Next message" },
      { keys: "k / ↑", description: "Previous message" },
      { keys: "↵", description: "Open the focused message" },
      { keys: "esc", description: "Back to the list" },
      { keys: "g then i", description: "Go to Inbox" },
      { keys: "g then s", description: "Go to Sent" },
      { keys: "g then d", description: "Go to Drafts" },
      { keys: "g then t", description: "Go to Trash" },
      { keys: "/", description: "Search" },
      { keys: "[", description: "Hide or show the sidebar" },
    ],
  },
  {
    title: "Act",
    entries: [
      { keys: "x", description: "Select the focused message" },
      { keys: "e", description: "Archive" },
      { keys: "#", description: "Move to Trash" },
      { keys: "!", description: "Spam, or Not spam in Spam" },
      { keys: "u", description: "Toggle read and unread" },
      { keys: "shift U", description: "Mark unread" },
      { keys: "s", description: "Toggle flag" },
      { keys: "⌘Z / ctrl Z", description: "Undo the last action" },
    ],
  },
  {
    title: "Write",
    entries: [
      { keys: "c", description: "Compose" },
      { keys: "r", description: "Reply" },
      { keys: "a", description: "Reply all" },
      { keys: "f", description: "Forward" },
    ],
  },
  {
    title: "Help",
    entries: [{ keys: "?", description: "Show keyboard shortcuts" }],
  },
];

export type ShortcutCommand =
  | "undo" | "toggle_sidebar" | "search" | "help"
  | "close" | "open" | "next" | "previous" | "select"
  | "archive" | "trash" | "spam" | "toggle_read" | "mark_unread" | "toggle_flag"
  | "compose" | "reply" | "reply_all" | "forward"
  | "go" | "go_inbox" | "go_sent" | "go_drafts" | "go_trash";

/** How long `g` waits for its target key. */
export const goChordMs = 1_500;

interface TargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  closest?(selector: string): unknown;
}

/**
 * True when keys pressed on `target` are text entry. The rich-text editor is a `contenteditable` div, so form tags
 * alone are not enough: missing it let Cmd+Z in compose undo the last mailbox action.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as TargetLike;
  const tag = element.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (element.isContentEditable === true) return true;
  return typeof element.closest === "function"
    && element.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]') != null;
}

interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Maps a key press outside text entry to a command. `chord` is true while a `g` waits for its target. */
export function shortcutCommand(event: KeyLike, chord: boolean): ShortcutCommand | null {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z" && !event.shiftKey) return "undo";
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (chord) {
    return ({ i: "go_inbox", s: "go_sent", d: "go_drafts", t: "go_trash" } as const)[event.key as "i"] ?? null;
  }
  switch (event.key) {
    case "[": return "toggle_sidebar";
    case "/": return "search";
    case "?": return "help";
    case "Escape": return "close";
    case "Enter": return "open";
    case "j": case "ArrowDown": return "next";
    case "k": case "ArrowUp": return "previous";
    case "x": return "select";
    case "e": return "archive";
    case "#": return "trash";
    case "!": return "spam";
    case "u": return "toggle_read";
    case "U": return event.shiftKey ? "mark_unread" : null;
    case "s": return "toggle_flag";
    case "c": return "compose";
    case "r": return "reply";
    case "a": return "reply_all";
    case "f": return "forward";
    case "g": return "go";
    default: return null;
  }
}
