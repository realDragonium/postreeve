import type { MessageDetail } from "../shared/contracts";
import { addressList, formatDate } from "./format";
import { normalizeHtml } from "./html-sanitizer";

const signatureDelimiter = "-- \n";
const quoteStyle = "margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return text.split("\n").map((line) => `<div>${line ? escapeHtml(line) : "<br>"}</div>`).join("");
}

export function plainForward(message: MessageDetail): string {
  return `\n\n---------- Forwarded message ----------\nFrom: ${addressList(message.from)}\nDate: ${formatDate(message.receivedAt, true)}\nSubject: ${message.subject}\nTo: ${addressList(message.to)}\n\n${message.text}`;
}

/** `sanitizedHtml` must already have passed `sanitizeComposeHtml`; without it the source text is quoted. */
export function htmlReplyQuote(message: MessageDetail, sanitizedHtml: string | null): string {
  const author = message.from[0]?.name || message.from[0]?.address || "Sender";
  return `<div data-postreeve-quote="" style="margin-top:1em"><div>On ${escapeHtml(formatDate(message.receivedAt, true))}, ${escapeHtml(author)} wrote:</div>`
    + `<blockquote type="cite" style="${quoteStyle}">${sanitizedHtml ?? textToHtml(message.text)}</blockquote></div>`;
}

export function htmlForward(message: MessageDetail, sanitizedHtml: string | null): string {
  const header = [
    "---------- Forwarded message ----------",
    `From: ${addressList(message.from)}`,
    `Date: ${formatDate(message.receivedAt, true)}`,
    `Subject: ${message.subject}`,
    `To: ${addressList(message.to)}`,
  ].map(escapeHtml).join("<br>");
  return `<div data-postreeve-quote="" style="margin-top:1em">${header}<br><br>${sanitizedHtml ?? textToHtml(message.text)}</div>`;
}

/**
 * Replaces the plain-text signature `previous` with `next`. Returns null when the body no longer holds
 * `previous` unchanged, or holds a signature although `previous` is empty, so user edits are kept.
 * A new signature is inserted before `anchor` (the generated quote) when present, else at the end.
 */
export function swapPlainSignature(body: string, previous: string, next: string, anchor = ""): string | null {
  if (previous) {
    const block = `\n\n${signatureDelimiter}${previous}`;
    const index = body.indexOf(block);
    const rest = index < 0 ? "" : body.slice(index + block.length);
    if (index < 0 || (rest && !rest.startsWith("\n"))) return null;
    return `${body.slice(0, index)}${next ? `\n\n${signatureDelimiter}${next}` : ""}${body.slice(index + block.length)}`;
  }
  if (body.includes(`\n${signatureDelimiter}`) || body.startsWith(signatureDelimiter)) return null;
  if (!next) return body;
  const block = `\n\n${signatureDelimiter}${next}`;
  const index = anchor ? body.lastIndexOf(anchor) : -1;
  return index < 0 ? `${body}${block}` : `${body.slice(0, index)}${block}${body.slice(index)}`;
}

/**
 * Rich-text counterpart of `swapPlainSignature` on the signature block. `previous` and `next` must be
 * sanitized HTML; the block is compared after browser normalization.
 */
export function swapRichSignature(html: string, previous: string, next: string): string | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  const block = template.content.querySelector("[data-postreeve-signature]");
  if (block) {
    if (block.innerHTML !== normalizeHtml(previous)) return null;
    if (next) block.innerHTML = next;
    else block.remove();
    return template.innerHTML;
  }
  if (previous) return null;
  if (!next) return html;
  const inserted = document.createElement("div");
  inserted.setAttribute("data-postreeve-signature", "");
  inserted.innerHTML = next;
  const quote = template.content.querySelector("[data-postreeve-quote]");
  if (quote) quote.before(inserted);
  else template.content.append(inserted);
  return template.innerHTML;
}
