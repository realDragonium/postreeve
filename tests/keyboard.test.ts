import { describe, expect, test } from "bun:test";
import { isTypingTarget, shortcutCommand, shortcutGroups } from "../src/web/keyboard";

const press = (key: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers,
});

describe("typing detection", () => {
  test("treats form fields as typing", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) expect(isTypingTarget({ tagName })).toBe(true);
  });

  test("treats the contenteditable rich-text editor as typing", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  test("treats children of an editor or textbox as typing", () => {
    const inside = { tagName: "STRONG", isContentEditable: false, closest: (selector: string) => selector.includes("contenteditable") ? {} : null };
    expect(isTypingTarget(inside)).toBe(true);
  });

  test("does not treat buttons, rows or the document as typing", () => {
    expect(isTypingTarget({ tagName: "BUTTON", isContentEditable: false, closest: () => null })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});

describe("shortcut commands", () => {
  test("maps undo with Command or Control but not with Shift or Alt", () => {
    expect(shortcutCommand(press("z", { metaKey: true }), false)).toBe("undo");
    expect(shortcutCommand(press("Z", { ctrlKey: true }), false)).toBe("undo");
    expect(shortcutCommand(press("z", { metaKey: true, shiftKey: true }), false)).toBeNull();
    expect(shortcutCommand(press("z", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  test("ignores letters with modifiers held", () => {
    expect(shortcutCommand(press("r", { ctrlKey: true }), false)).toBeNull();
    expect(shortcutCommand(press("e", { altKey: true }), false)).toBeNull();
  });

  test("maps the single-key shortcuts", () => {
    expect(shortcutCommand(press("r"), false)).toBe("reply");
    expect(shortcutCommand(press("a"), false)).toBe("reply_all");
    expect(shortcutCommand(press("f"), false)).toBe("forward");
    expect(shortcutCommand(press("c"), false)).toBe("compose");
    expect(shortcutCommand(press("#", { shiftKey: true }), false)).toBe("trash");
    expect(shortcutCommand(press("?", { shiftKey: true }), false)).toBe("help");
    expect(shortcutCommand(press("U", { shiftKey: true }), false)).toBe("mark_unread");
    expect(shortcutCommand(press("U"), false)).toBeNull();
    expect(shortcutCommand(press("u"), false)).toBe("toggle_read");
  });

  test("resolves g chords and drops unknown targets", () => {
    expect(shortcutCommand(press("g"), false)).toBe("go");
    expect(shortcutCommand(press("i"), true)).toBe("go_inbox");
    expect(shortcutCommand(press("s"), true)).toBe("go_sent");
    expect(shortcutCommand(press("d"), true)).toBe("go_drafts");
    expect(shortcutCommand(press("t"), true)).toBe("go_trash");
    expect(shortcutCommand(press("e"), true)).toBeNull();
  });

  test("lists every key the handler maps in the help table", () => {
    const listed = shortcutGroups.flatMap(({ entries }) => entries.map(({ keys }) => keys)).join(" ");
    for (const key of ["j", "k", "x", "e", "#", "!", "u", "shift U", "s", "c", "r", "a", "f", "/", "[", "?", "g then i", "g then t", "⌘Z"]) {
      expect(listed).toContain(key);
    }
  });
});
