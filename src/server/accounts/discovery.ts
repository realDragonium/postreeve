import type { AccountDiscovery, DiscoveredAccountSettings } from "../../shared/contracts";
import { providerForDomain, providerForMxHost, type ProviderEntry, type ServerSettings } from "./providers";

export type DiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ResolveMx = (domain: string) => Promise<ReadonlyArray<{ exchange: string; priority: number }>>;

export interface AccountDiscoveryOptions {
  readonly fetch: DiscoveryFetch;
  readonly resolveMx: ResolveMx;
  readonly timeoutMs?: number;
}

export type DiscoverAccount = (email: string) => Promise<AccountDiscovery>;

export const ISPDB_ORIGIN = "https://autoconfig.thunderbird.net";
export const MAX_DOCUMENT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const nothing: AccountDiscovery = { provider: null, source: null, settings: null };

export function createAccountDiscovery(options: AccountDiscoveryOptions): DiscoverAccount {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (email) => {
    const domain = lookupDomain(email);
    if (!domain) return nothing;

    const known = providerForDomain(domain);
    if (known) return fromProvider(known, "provider", email);

    const document = (url: string) => fetchDocument(options.fetch, url, timeoutMs)
      .then((text) => text === null ? null : parseClientConfig(text, email));
    const [subdomain, wellKnown, ispdb, mx] = await Promise.all([
      document(`https://autoconfig.${domain}/mail/config-v1.1.xml`),
      document(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`),
      document(`${ISPDB_ORIGIN}/v1.1/${domain}`),
      preferredMxProvider(options.resolveMx, domain, timeoutMs),
    ]);

    const autoconfig = subdomain ?? wellKnown;
    if (autoconfig) return { provider: null, source: "autoconfig", settings: autoconfig };
    if (ispdb) return { provider: null, source: "ispdb", settings: ispdb };
    if (mx) return fromProvider(mx, "mx", email);
    return nothing;
  };
}

function fromProvider(entry: ProviderEntry, source: "provider" | "mx", email: string): AccountDiscovery {
  if (!entry.servers) return { provider: entry.id, source, settings: null };
  const { imap, smtp } = entry.servers;
  return { provider: entry.id, source, settings: settingsFrom(imap, email, smtp, email) };
}

function settingsFrom(imap: ServerSettings, username: string, smtp: ServerSettings, smtpUsername: string): DiscoveredAccountSettings {
  return {
    host: imap.host, port: imap.port, secure: imap.secure, username,
    smtpHost: smtp.host, smtpPort: smtp.port, smtpSecure: smtp.secure, smtpUsername,
  };
}

/** Returns the normalized domain only when it is a public-looking DNS name worth looking up. */
export function lookupDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const raw = email.slice(at + 1).trim().replace(/\.$/, "");
  if (raw.startsWith("[") || /[\s/\\:?#@%]/.test(raw)) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${raw}`).hostname;
  } catch {
    return null;
  }
  return isDnsName(hostname) ? hostname : null;
}

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isDnsName(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split(".");
  if (labels.length < 2 || !labels.every((label) => labelPattern.test(label))) return false;
  return !/^\d+$/.test(labels.at(-1) ?? "");
}

async function fetchDocument(fetcher: DiscoveryFetch, url: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "application/xml, text/xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

async function preferredMxProvider(resolveMx: ResolveMx, domain: string, timeoutMs: number): Promise<ProviderEntry | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MX lookup timed out")), timeoutMs); }),
    ]);
    const preferred = [...records].sort((left, right) => left.priority - right.priority)[0];
    return preferred ? providerForMxHost(preferred.exchange) ?? null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface ConfigServer extends ServerSettings {
  readonly username: string;
}

/** Reads the Thunderbird autoconfig (clientConfig v1.1) format without an XML dependency. */
export function parseClientConfig(xml: string, email: string): DiscoveredAccountSettings | null {
  if (!xml.includes("<clientConfig")) return null;
  const imap = firstUsableServer(xml, "incomingServer", "imap", email);
  const smtp = firstUsableServer(xml, "outgoingServer", "smtp", email);
  return imap && smtp ? settingsFrom(imap, imap.username, smtp, smtp.username) : null;
}

function firstUsableServer(xml: string, element: string, type: string, email: string): ConfigServer | null {
  const blocks = xml.matchAll(new RegExp(`<${element}\\s+type\\s*=\\s*["']${type}["']\\s*>([\\s\\S]*?)</${element}>`, "g"));
  for (const [, body = ""] of blocks) {
    const host = childText(body, "hostname")?.toLowerCase();
    const port = Number(childText(body, "port"));
    const socketType = childText(body, "socketType");
    const authentication = childTexts(body, "authentication");
    if (!host || !isDnsName(host)) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (socketType !== "SSL" && socketType !== "STARTTLS") continue;
    if (authentication.length > 0
      && !authentication.some((method) => method === "password-cleartext" || method === "password-encrypted")) continue;
    return { host, port, secure: socketType === "SSL", username: expandUsername(childText(body, "username"), email) };
  }
  return null;
}

function childTexts(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))]
    .map(([, text = ""]) => decodeEntities(text).trim());
}

function childText(body: string, name: string): string | undefined {
  return childTexts(body, name)[0];
}

function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) =>
    ({ lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" })[entity] ?? "");
}

function expandUsername(template: string | undefined, email: string): string {
  if (!template) return email;
  const at = email.lastIndexOf("@");
  const expanded = template
    .replaceAll("%EMAILADDRESS%", email)
    .replaceAll("%EMAILLOCALPART%", email.slice(0, at))
    .replaceAll("%EMAILDOMAIN%", email.slice(at + 1));
  return expanded.includes("%") || expanded.length === 0 ? email : expanded;
}
