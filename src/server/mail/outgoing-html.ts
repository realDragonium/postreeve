import { convert } from "html-to-text";
import sanitizeHtml from "sanitize-html";
import { allowedInlineStyles } from "../../shared/inline-styles";

const outgoingHtmlOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "small", "big", "font", "span", "code",
    "br", "p", "div", "blockquote", "pre", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "center",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    "img",
  ],
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head", "template", "svg", "math", "iframe", "object"],
  allowedAttributes: {
    "*": ["style", "dir", "align", "title"],
    a: ["href"],
    img: ["src", "alt", "width", "height"],
    font: ["color", "face", "size"],
    ol: ["start", "type"],
    table: ["width", "border", "cellpadding", "cellspacing", "bgcolor"],
    td: ["colspan", "rowspan", "width", "height", "valign", "bgcolor"],
    th: ["colspan", "rowspan", "width", "height", "valign", "bgcolor"],
    col: ["span", "width"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["data"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  allowedStyles: { "*": allowedInlineStyles },
  exclusiveFilter: (frame) => frame.tag === "img" && !/^data:image\//i.test(frame.attribs.src ?? ""),
};

/** The allowlist every outgoing HTML body passes, whatever the client sent. */
export function sanitizeOutgoingHtml(html: string): string {
  return sanitizeHtml(html, outgoingHtmlOptions);
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "table", format: "dataTable" },
    ],
  }).replace(/\n{3,}/g, "\n\n").trim();
}
