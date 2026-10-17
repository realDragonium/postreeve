import { Resolver } from "node:dns/promises";
import type { DnsCheck, DnsRecord, DnsRecordCategory } from "../../shared/mail-server";

const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_CONCURRENCY = 6;
export const DEFAULT_DOH_URL = "https://cloudflare-dns.com/dns-query";
const supportedTypes = new Set(["TXT", "MX", "CNAME", "SRV", "CAA", "A", "AAAA", "TLSA"]);

/** Answers for one name and type, as presentation strings (TXT joined, MX as "10 host."). */
export interface DnsLookup {
  readonly label: string;
  lookup(name: string, type: string): Promise<string[]>;
}

/** Splits Stalwart's generated BIND zone into one record per entry, joining multi-string TXT values. */
export function parseZoneFile(zone: string, origin: string): DnsRecord[] {
  const records: DnsRecord[] = [];
  const lines = zone.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = stripComment(lines[index]!).trim();
    if (!line || line.startsWith("$")) continue;
    // A parenthesised value continues until the closing parenthesis.
    if (line.includes("(") && !line.includes(")")) {
      while (index + 1 < lines.length && !line.includes(")")) line += ` ${stripComment(lines[++index]!).trim()}`;
    }
    line = line.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    const match = /^(\S+)\s+(?:\d+\s+)?(?:IN\s+)?(?:\d+\s+)?([A-Z]+)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const name = absoluteName(match[1]!, origin);
    const type = match[2]!.toUpperCase();
    const rawValue = match[3]!.trim();
    const value = type === "TXT" ? joinTxt(rawValue) : rawValue;
    records.push({ category: categorize(name, type, value, origin), name, type, value });
  }
  return records;
}

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"" && line[index - 1] !== "\\") quoted = !quoted;
    if (char === ";" && !quoted) return line.slice(0, index);
  }
  return line;
}

function joinTxt(value: string): string {
  const parts = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1]!.replace(/\\(.)/g, "$1"));
  return parts.length ? parts.join("") : value;
}

function absoluteName(name: string, origin: string): string {
  if (name === "@") return `${origin}.`;
  return name.endsWith(".") ? name.toLowerCase() : `${name}.${origin}.`.toLowerCase();
}

function categorize(name: string, type: string, value: string, origin: string): DnsRecordCategory {
  const host = name.replace(/\.$/, "");
  const lower = value.toLowerCase();
  if (type === "MX") return "mx";
  if (type === "CAA") return "caa";
  if (type === "SRV") return "srv";
  if (type === "TXT" && lower.startsWith("v=spf1")) return "spf";
  if (type === "TXT" && lower.startsWith("v=dkim") || host.includes("._domainkey.")) return "dkim";
  if (host === `_dmarc.${origin}`) return "dmarc";
  if (host === `_mta-sts.${origin}` || host === `mta-sts.${origin}`) return "mta-sts";
  if (host === `_smtp._tls.${origin}`) return "tls-rpt";
  if (host === `autodiscover.${origin}`) return "autodiscover";
  if (/^_?(ua-)?auto-?config\./.test(host)) return "autoconfig";
  return "other";
}

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const host = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

function matches(record: DnsRecord, answer: string): boolean {
  if (record.type === "TXT") return normalize(answer) === normalize(record.value);
  if (record.type === "MX" || record.type === "SRV" || record.type === "CNAME") {
    const want = record.value.split(/\s+/);
    const got = answer.split(/\s+/);
    return want.length === got.length && want.every((part, index) => index === want.length - 1 ? host(part) === host(got[index]!) : part === got[index]);
  }
  return normalize(answer).toLowerCase() === normalize(record.value).toLowerCase();
}

/** Whether an answer is the same kind of policy record, so a mismatch is "different" rather than "missing". */
function sameKind(record: DnsRecord, answer: string): boolean {
  if (record.type !== "TXT") return true;
  const prefix = /^v=[a-z0-9]+/i.exec(record.value)?.[0]?.toLowerCase();
  return prefix ? answer.toLowerCase().startsWith(prefix) : true;
}

export async function checkRecords(records: readonly DnsRecord[], dns: DnsLookup): Promise<DnsCheck[]> {
  const results = new Array<DnsCheck>(records.length);
  let next = 0;
  const worker = async () => {
    while (next < records.length) {
      const index = next++;
      results[index] = await checkRecord(records[index]!, dns);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, records.length) }, worker));
  return results;
}

async function checkRecord(record: DnsRecord, dns: DnsLookup): Promise<DnsCheck> {
  if (!supportedTypes.has(record.type)) return { ...record, status: "error", found: [], error: `${record.type} lookups are not supported` };
  try {
    const answers = await dns.lookup(record.name, record.type);
    const relevant = answers.filter((answer) => sameKind(record, answer));
    if (answers.some((answer) => matches(record, answer))) return { ...record, status: "ok", found: answers, error: null };
    return { ...record, status: relevant.length ? "different" : "missing", found: relevant, error: null };
  } catch (error) {
    return { ...record, status: "error", found: [], error: error instanceof Error ? error.message : "Lookup failed" };
  }
}

const dohTypes: Record<string, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33, TLSA: 52, CAA: 257 };

/** DNS-over-HTTPS (JSON API). Sends only the name and type. */
export function dohLookup(fetchImpl: typeof fetch = fetch, endpoint = process.env.POSTREEVE_DOH_URL ?? DEFAULT_DOH_URL): DnsLookup {
  return {
    label: `DNS-over-HTTPS (${new URL(endpoint).hostname})`,
    lookup: async (name, type) => {
      const url = new URL(endpoint);
      url.searchParams.set("name", name);
      url.searchParams.set("type", type);
      const response = await fetchImpl(url, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Resolver answered HTTP ${response.status}`);
      const body = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
      // NXDOMAIN (3) is an answer: the record is missing.
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`Resolver status ${body.Status}`);
      return (body.Answer ?? []).filter((answer) => answer.type === dohTypes[type])
        .map((answer) => type === "TXT" ? joinTxt(answer.data) : answer.data);
    },
  };
}

export function systemLookup(): DnsLookup {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 2 });
  const missing = (error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw error;
  };
  return {
    label: "System resolver",
    lookup: async (name, type) => {
      switch (type) {
        case "TXT": return (await resolver.resolveTxt(name).catch(missing)).map((parts) => parts.join(""));
        case "MX": return (await resolver.resolveMx(name).catch(missing)).map(({ priority, exchange }) => `${priority} ${exchange}.`);
        case "CNAME": return (await resolver.resolveCname(name).catch(missing)).map((target) => `${target}.`);
        case "SRV": return (await resolver.resolveSrv(name).catch(missing)).map(({ priority, weight, port, name: target }) => `${priority} ${weight} ${port} ${target}.`);
        case "CAA": return (await resolver.resolveCaa(name).catch(missing)).map((record) => {
          const [tag, value] = Object.entries(record).find(([key]) => key !== "critical") ?? ["", ""];
          return `${record.critical} ${tag} "${value}"`;
        });
        case "A": return resolver.resolve4(name).catch(missing);
        case "AAAA": return resolver.resolve6(name).catch(missing);
        default: throw new Error(`${type} lookups are not supported by the system resolver`);
      }
    },
  };
}

export function defaultDnsLookup(): DnsLookup {
  return process.env.POSTREEVE_DNS_RESOLVER === "system" ? systemLookup() : dohLookup();
}
