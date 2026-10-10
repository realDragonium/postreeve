import { z } from "zod";
import { isDnsName } from "../accounts/discovery";
import type { UnsubscribeOptions } from "../../shared/contracts";

export { mailtoUnsubscribe } from "../../shared/unsubscribe";

export type UnsubscribeFetch = (url: string, init: RequestInit) => Promise<Response>;

const ONE_CLICK_TIMEOUT_MS = 10_000;
const MAX_URI_LENGTH = 2_048;

/** Reads `List-Unsubscribe` from raw header lines; mailparser rewrites `List-*` headers into its own shape. */
export function unsubscribeOptions(headerLines: readonly { key: string; line: string }[]): UnsubscribeOptions | undefined {
  const value = (name: string) => {
    const header = headerLines.find(({ key }) => key.toLowerCase() === name);
    if (!header) return null;
    const separator = header.line.indexOf(":");
    return header.line.slice(separator + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  };
  const uris = [...(value("list-unsubscribe") ?? "").matchAll(/<([^>]*)>/g)]
    .map(([, uri = ""]) => uri.replace(/\s+/g, ""))
    .filter((uri) => uri.length > 0 && uri.length <= MAX_URI_LENGTH);
  const https = uris.find((uri) => z.url({ protocol: /^https$/ }).safeParse(uri).success) ?? null;
  const mailto = uris.find((uri) => uri.toLowerCase().startsWith("mailto:")) ?? null;
  if (!https && !mailto) return undefined;
  const oneClick = https !== null && value("list-unsubscribe-post")?.toLowerCase() === "list-unsubscribe=one-click";
  return { https, mailto: mailto && `mailto:${mailto.slice("mailto:".length)}`, oneClick };
}

/** Sends the RFC 8058 one-click POST without cookies, credentials or redirects, to public DNS names only. */
export async function postOneClickUnsubscribe(
  fetcher: UnsubscribeFetch,
  uri: string,
  timeoutMs = ONE_CLICK_TIMEOUT_MS,
): Promise<void> {
  const url = new URL(uri);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !isDnsName(url.hostname) || url.hostname.endsWith(".localhost")) {
    throw new Error("The one-click unsubscribe address is not a public HTTPS address");
  }
  let response: Response;
  try {
    response = await fetcher(url.href, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`One-click unsubscribe to ${url.hostname} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await response.body?.cancel();
  if (response.status < 200 || response.status > 299) {
    throw new Error(`One-click unsubscribe was refused by ${url.hostname} (HTTP ${response.status})`);
  }
}
