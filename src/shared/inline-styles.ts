const cssLength = /^(?:0|-?\d+(?:\.\d+)?(?:px|em|rem|ex|%|pt))(?:\s+(?:0|-?\d+(?:\.\d+)?(?:px|em|rem|ex|%|pt))){0,3}$/i;
const cssColor = /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\(\s*[\d.\s,%]+\))$/i;
const cssKeyword = /^[a-z-]+$/i;
const cssFontFamily = /^[\w\s,'"-]+$/;
const cssBorderPart = String.raw`(?:[\w#.%-]+|rgba?\(\s*[\d.\s,%]+\))`;
const cssBorder = new RegExp(String.raw`^${cssBorderPart}(?:\s+${cssBorderPart})*$`, "i");

/**
 * Inline style properties kept in composed and outgoing HTML, each with the value patterns it accepts.
 * None of these properties can reference an image or font, and no pattern admits `/`, `\` or a
 * function other than `rgb()`/`rgba()`, so a kept style never makes the browser fetch anything.
 */
export const allowedInlineStyles: Record<string, RegExp[]> = {
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
};

/** Keeps only the allowlisted declarations of a `style` attribute value. */
export function filterInlineStyle(style: string): string {
  return style.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 0) return [];
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    const patterns = Object.hasOwn(allowedInlineStyles, property) ? allowedInlineStyles[property] : undefined;
    return patterns?.some((pattern) => pattern.test(value)) ? [`${property}:${value}`] : [];
  }).join(";");
}
