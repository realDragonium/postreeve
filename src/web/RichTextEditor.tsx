import { useLayoutEffect, useRef, type ClipboardEvent } from "react";
import { isSafeLink, sanitizeComposeHtml } from "./html-sanitizer";

const commands = [
  { label: "Bold", text: "B", command: "bold", style: { fontWeight: 700 } },
  { label: "Italic", text: "I", command: "italic", style: { fontStyle: "italic" } },
  { label: "Bulleted list", text: "• List", command: "insertUnorderedList" },
  { label: "Numbered list", text: "1. List", command: "insertOrderedList" },
  { label: "Quote", text: "❝ Quote", command: "formatBlock", value: "blockquote" },
] as const;

/**
 * A `contenteditable` editor using the browser's editing commands. Every HTML value it receives from
 * outside is sanitized before display; edits are reported as the element's HTML.
 */
export function RichTextEditor({ html, label, disabled = false, onChange }: {
  html: string;
  label: string;
  disabled?: boolean;
  onChange: (html: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!editor.current || html === shown.current) return;
    editor.current.innerHTML = sanitizeComposeHtml(html);
    shown.current = html;
  }, [html]);

  function emit(): void {
    if (!editor.current) return;
    shown.current = editor.current.innerHTML;
    onChange(shown.current);
  }

  function run(command: string, value?: string): void {
    editor.current?.focus();
    document.execCommand("defaultParagraphSeparator", false, "div");
    document.execCommand(command, false, value);
    emit();
  }

  function addLink(): void {
    const url = window.prompt("Link address", "https://")?.trim();
    if (!url || url.startsWith("#") || !isSafeLink(url)) return;
    run("createLink", url);
  }

  function paste(event: ClipboardEvent<HTMLDivElement>): void {
    const pasted = event.clipboardData.getData("text/html");
    if (!pasted) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, sanitizeComposeHtml(pasted));
    emit();
  }

  return <div className="rich-editor" aria-disabled={disabled}>
    <div className="rich-toolbar" role="toolbar" aria-label={`${label} formatting`}>
      {commands.map((item) => <button
        key={item.label}
        type="button"
        className="chip"
        aria-label={item.label}
        title={item.label}
        disabled={disabled}
        style={"style" in item ? item.style : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(item.command, "value" in item ? item.value : undefined)}
      >{item.text}</button>)}
      <button type="button" className="chip" aria-label="Link" title="Link" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={addLink}>Link</button>
    </div>
    <div
      ref={editor}
      className="input rich-editor-content"
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-disabled={disabled}
      contentEditable={!disabled}
      suppressContentEditableWarning
      onInput={emit}
      onPaste={paste}
    />
  </div>;
}
