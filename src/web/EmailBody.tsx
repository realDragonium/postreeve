import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";

interface EmailBodyProps {
  readonly html: string | null;
  readonly text: string;
  readonly title: string;
}

interface PreparedEmail {
  readonly blockedRemoteResources: number;
  readonly document: string;
}

const minimumFrameHeight = 160;
const maximumFrameHeight = 8_000;
const resourceAttributes = ["src", "poster", "background"] as const;
const lazyResourceAttributes = ["data-src", "data-original", "data-lazy-src"] as const;
const sourceSetAttributes = ["srcset", "data-srcset"] as const;
const remoteUrlPattern = /^(?:https?:)?\/\//i;
const remoteUrlInValuePattern = /(?:https?:)?\/\/[^\s,"')]+/gi;
const remoteCssUrlPattern = /url\s*\(\s*(["']?)(?:https?:)?\/\//gi;

function isRemoteUrl(value: string): boolean {
  return remoteUrlPattern.test(value.trim());
}

function normalizeRemoteUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
}

function normalizeRemoteUrls(value: string): string {
  return value.replace(remoteUrlInValuePattern, (url) => normalizeRemoteUrl(url));
}

function isSafeLink(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("#") || /^(?:https?:|mailto:|tel:)/i.test(normalized);
}

function markUnavailableImage(element: Element): void {
  if (element.tagName !== "IMG") return;
  element.removeAttribute("srcset");
  element.classList.add("postreeve-blocked-image");
  if (!element.getAttribute("alt")) element.setAttribute("alt", "Remote image blocked");
}

function prepareEmail(html: string, allowRemoteResources: boolean): PreparedEmail {
  const cleaned = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORCE_BODY: true,
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option", "base", "link", "meta"],
    FORBID_ATTR: ["srcdoc", "action", "formaction", "ping"],
  });
  const parsed = new DOMParser().parseFromString(cleaned, "text/html");
  let blockedRemoteResources = 0;

  for (const element of parsed.querySelectorAll("[src], [poster], [background]")) {
    let resourceUnavailable = false;
    for (const attribute of resourceAttributes) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      if (isRemoteUrl(value)) {
        blockedRemoteResources += 1;
        if (!allowRemoteResources) {
          element.removeAttribute(attribute);
          resourceUnavailable = true;
        } else {
          element.setAttribute(attribute, normalizeRemoteUrl(value));
        }
      } else if (/^cid:/i.test(value) || (!/^(?:data:|blob:)/i.test(value) && !value.startsWith("#"))) {
        element.removeAttribute(attribute);
        resourceUnavailable = true;
      }
    }
    if (resourceUnavailable) markUnavailableImage(element);
  }

  for (const element of parsed.querySelectorAll("[data-src], [data-original], [data-lazy-src]")) {
    let resourceUnavailable = false;
    for (const attribute of lazyResourceAttributes) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      element.removeAttribute(attribute);
      if (!isRemoteUrl(value)) continue;
      blockedRemoteResources += 1;
      if (allowRemoteResources) element.setAttribute("src", normalizeRemoteUrl(value));
      else resourceUnavailable = true;
    }
    if (resourceUnavailable) markUnavailableImage(element);
  }

  for (const element of parsed.querySelectorAll("[srcset], [data-srcset]")) {
    let resourceUnavailable = false;
    for (const attribute of sourceSetAttributes) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      if (attribute === "data-srcset") element.removeAttribute(attribute);
      const remoteResources = value.match(remoteUrlInValuePattern)?.length ?? 0;
      if (remoteResources === 0) {
        if (/javascript:/i.test(value)) element.removeAttribute("srcset");
        continue;
      }
      blockedRemoteResources += remoteResources;
      if (allowRemoteResources) element.setAttribute("srcset", normalizeRemoteUrls(value));
      else {
        element.removeAttribute("srcset");
        resourceUnavailable = true;
      }
    }
    if (resourceUnavailable) markUnavailableImage(element);
  }

  for (const anchor of parsed.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href || !isSafeLink(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }

  const styledElements = [
    ...parsed.head.querySelectorAll("style"),
    ...parsed.body.querySelectorAll("style"),
    ...parsed.body.querySelectorAll("[style]"),
  ];
  for (const element of styledElements) {
    const css = element.tagName === "STYLE" ? element.textContent ?? "" : element.getAttribute("style") ?? "";
    blockedRemoteResources += css.match(remoteCssUrlPattern)?.length ?? 0;
    if (!allowRemoteResources) continue;
    const normalized = css.replace(remoteCssUrlPattern, (_match, quote: string) => `url(${quote}https://`);
    if (element.tagName === "STYLE") element.textContent = normalized;
    else element.setAttribute("style", normalized);
  }

  const imagePolicy = allowRemoteResources
    ? "img-src data: blob: http: https:;"
    : "img-src data: blob:;";
  const headStyles = [...parsed.head.querySelectorAll("style")].map((style) => style.outerHTML).join("\n");
  const contentSecurityPolicy = [
    "default-src 'none';",
    "base-uri 'none';",
    "connect-src 'none';",
    "font-src data:;",
    imagePolicy,
    "media-src data: blob:;",
    "object-src 'none';",
    "script-src 'none';",
    "style-src 'unsafe-inline';",
    "form-action 'none';",
  ].join(" ");

  return {
    blockedRemoteResources,
    document: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
    <meta name="color-scheme" content="light">
    <style>
      :root { color-scheme: light; }
      html, body { min-width: 0; margin: 0; padding: 0; background: #fff; color: #171717; }
      body { overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
      pre { white-space: pre-wrap; }
      .postreeve-blocked-image { display: inline-block; min-width: 8rem; min-height: 1.5rem; padding: .25rem .5rem; box-sizing: border-box; background: #f0f0f0; color: #666; font: 12px/1.4 system-ui, sans-serif; }
    </style>
    ${headStyles}
  </head>
  <body>${parsed.body.innerHTML}</body>
</html>`,
  };
}

export function EmailBody({ html, text, title }: EmailBodyProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [allowRemoteResources, setAllowRemoteResources] = useState(false);
  const [frameHeight, setFrameHeight] = useState(minimumFrameHeight);
  const prepared = useMemo(
    () => html?.trim() ? prepareEmail(html, allowRemoteResources) : null,
    [allowRemoteResources, html],
  );

  useEffect(() => {
    setAllowRemoteResources(false);
  }, [html]);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), [prepared?.document]);

  function resizeFrame(): void {
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    setFrameHeight(Math.min(maximumFrameHeight, Math.max(minimumFrameHeight, height + 2)));
  }

  function observeFrame(): void {
    resizeObserverRef.current?.disconnect();
    resizeFrame();
    const body = frameRef.current?.contentDocument?.body;
    if (!body) return;
    const observer = new ResizeObserver(resizeFrame);
    observer.observe(body);
    resizeObserverRef.current = observer;
  }

  if (!prepared) return <div className="msgbody plain">{text}</div>;

  return <>
    {prepared.blockedRemoteResources > 0 && !allowRemoteResources ? <div className="notice email-resource-notice">
      <span>Remote images blocked to protect your privacy.</span>
      <button className="btn-underline" onClick={() => setAllowRemoteResources(true)}>Load images</button>
    </div> : null}
    <div className="email-frame-shell">
      <iframe
        ref={frameRef}
        className="email-frame"
        title={title || "Email message"}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={prepared.document}
        style={{ height: frameHeight }}
        onLoad={observeFrame}
      />
    </div>
  </>;
}
