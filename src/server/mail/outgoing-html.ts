import { convert } from "html-to-text";
import sanitizeHtml from "sanitize-html";

const cssLength = /^(?:0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))(?:\s+(?:0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))){0,3}$/i;
const cssColor = /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\(\s*[\d.\s,%]+\))$/i;
const cssKeyword = /^[a-z-]+$/i;
const cssFontFamily = /^[\w\s,'"-]+$/;
const cssBorder = /^[\w\s#.%(),-]+$/i;

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
  allowedStyles: {
    "*": {
      color: [cssColor],
      "background-color": [cssColor],
      "font-weight": [cssKeyword, /^\d{3}$/],
      "font-style": [cssKeyword],
      "font-size": [cssLength, cssKeyword],
      "font-family": [cssFontFamily],
      "text-decoration": [/^[a-z\s-]+$/i],
      "text-align": [cssKeyword],
      "line-height": [cssLength, /^\d+(?:\.\d+)?$/],
      "white-space": [cssKeyword],
      "vertical-align": [cssKeyword],
      margin: [cssLength],
      "margin-top": [cssLength], "margin-right": [cssLength], "margin-bottom": [cssLength], "margin-left": [cssLength],
      padding: [cssLength],
      "padding-top": [cssLength], "padding-right": [cssLength], "padding-bottom": [cssLength], "padding-left": [cssLength],
      border: [cssBorder],
      "border-left": [cssBorder],
      "border-collapse": [cssKeyword],
      width: [cssLength, cssKeyword],
      height: [cssLength, cssKeyword],
    },
  },
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
