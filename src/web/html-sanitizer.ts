import DOMPurify from "dompurify";
import { filterInlineStyle } from "../shared/inline-styles";

const remoteResourceAttributes = ["src", "srcset", "poster", "background", "data-src", "data-srcset", "data-original", "data-lazy-src"] as const;
const blockElements = new Set([
  "ADDRESS", "ARTICLE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL",
]);

/** The reader's rules for received HTML; remote resources are handled by the caller. */
export function sanitizeEmailHtml(html: string, forbidStyleSheets = false): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORCE_BODY: true,
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: [
      "script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option", "base", "link", "meta",
      ...forbidStyleSheets ? ["style"] : [],
    ],
    FORBID_ATTR: ["srcdoc", "action", "formaction", "ping"],
  });
}

export function isSafeLink(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("#") || /^(?:https?:|mailto:|tel:)/i.test(normalized);
}

/**
 * HTML allowed into the compose editor: the reader's rules without style sheets, inline styles limited
 * to the outgoing allowlist, and without any resource the browser would fetch, so composing never
 * contacts a remote server.
 */
export function sanitizeComposeHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(sanitizeEmailHtml(html, true), "text/html");
  for (const image of parsed.body.querySelectorAll("img")) {
    if (/^data:image\//i.test(image.getAttribute("src") ?? "")) continue;
    const alt = image.getAttribute("alt")?.trim();
    image.replaceWith(alt ? parsed.createTextNode(`[${alt}]`) : "");
  }
  for (const element of parsed.body.querySelectorAll("*")) {
    for (const attribute of remoteResourceAttributes) {
      const value = element.getAttribute(attribute);
      if (value !== null && !(element.tagName === "IMG" && attribute === "src" && /^data:image\//i.test(value))) {
        element.removeAttribute(attribute);
      }
    }
    const style = element.getAttribute("style");
    if (style !== null) {
      const kept = filterInlineStyle(style);
      if (kept) element.setAttribute("style", kept);
      else element.removeAttribute("style");
    }
    const href = element.getAttribute("href");
    if (href !== null && !isSafeLink(href)) element.removeAttribute("href");
  }
  return parsed.body.innerHTML;
}

/** Serializes HTML the way the browser stores it, so signatures can be compared with editor content. */
export function normalizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.innerHTML;
}

export function htmlToText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  let text = "";
  const breakLine = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const walk = (node: Node, quoteDepth: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    const block = blockElements.has(node.tagName);
    if (block) breakLine();
    if (node.tagName === "LI") text += "- ";
    const before = text.length;
    for (const child of node.childNodes) walk(child, quoteDepth + (node.tagName === "BLOCKQUOTE" ? 1 : 0));
    if (node.tagName === "BLOCKQUOTE") {
      const quoted = text.slice(before).replace(/\n$/, "").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
      text = `${text.slice(0, before)}${quoted}`;
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      if (href && href !== node.textContent && !href.startsWith("#")) text += ` <${href.replace(/^mailto:/i, "")}>`;
    }
    if (block) breakLine();
  };
  walk(parsed.body, 0);
  return text.split("\n").map((line) => line.replace(/^ +| +$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
