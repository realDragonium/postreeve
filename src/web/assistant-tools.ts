/**
 * Which WebMCP tools this browser offers the assistant. Registration happens
 * client-side, so hiding a tool here genuinely stops it being offered.
 */
export interface AssistantTool {
  readonly name: string;
  readonly effect: string;
}

export const assistantTools: readonly AssistantTool[] = [
  { name: "list_accounts", effect: "read" },
  { name: "list_folders", effect: "read" },
  { name: "list_messages", effect: "read" },
  { name: "read_messages", effect: "read" },
  { name: "search_messages", effect: "read" },
  { name: "list_activity", effect: "read" },
  { name: "create_folder", effect: "write" },
  { name: "rename_folder", effect: "write" },
  { name: "delete_folder", effect: "write · destructive" },
  { name: "apply_message_actions", effect: "write · undoable" },
  { name: "undo_batch", effect: "write · undoable" },
  { name: "send_message", effect: "irreversible" },
];

const storageKey = "postreeve.hidden-tools.v1";

export function loadHiddenTools(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function storeHiddenTools(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...hidden]));
  } catch {
    // The choice applies to this session only when storage is unavailable.
  }
}

export function exposedToolNames(hidden: ReadonlySet<string>): string[] {
  return assistantTools.map(({ name }) => name).filter((name) => !hidden.has(name));
}
