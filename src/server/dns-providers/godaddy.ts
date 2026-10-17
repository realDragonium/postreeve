import { DnsProviderAccessError, DnsProviderError, absolute, type DnsProviderClient, type DnsValue, type ProviderRecord } from "./types";

const API = "https://api.godaddy.com";
const TTL_SECONDS = 600; // GoDaddy's minimum
const TIMEOUT_MS = 15_000;
const ACCESS_MESSAGE = "GoDaddy refused API access. Since 2024 GoDaddy limits its production DNS API to some accounts; publish the records from the checklist by hand";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
interface GoDaddyRecord { type: string; name: string; data: string; ttl?: number; priority?: number }

/**
 * GoDaddy's v1 DNS API. Records have no ids, so changes edit the set of one type and name and replace it.
 * SRV records use separate service and protocol fields that this client does not map; they stay in the checklist.
 */
export class GoDaddyDns implements DnsProviderClient {
  readonly label = "GoDaddy";
  readonly types = new Set(["MX", "TXT", "CNAME"]);
  readonly #auth: string;
  readonly #fetch: Fetch;

  constructor(apiKey: string, apiSecret: string, fetchImpl: Fetch = fetch) {
    this.#auth = `sso-key ${apiKey}:${apiSecret}`;
    this.#fetch = fetchImpl;
  }

  async listZones(): Promise<string[]> {
    const domains = await this.#call<{ domain: string }[]>("GET", "/v1/domains?statuses=ACTIVE&limit=1000");
    return domains.map(({ domain }) => absolute(domain)).sort();
  }

  async listRecords(zone: string): Promise<ProviderRecord[]> {
    const records = await this.#call<GoDaddyRecord[]>("GET", `/v1/domains/${zone}/records`);
    return records.filter((record) => this.types.has(record.type)).map((record) => toValue(zone, record));
  }

  async create(zone: string, record: DnsValue): Promise<void> {
    const set = await this.#set(zone, record);
    await this.#replace(zone, record, [...set, toGoDaddy(zone, record)]);
  }

  async update(zone: string, record: ProviderRecord, next: DnsValue): Promise<void> {
    const set = await this.#set(zone, record);
    await this.#replace(zone, record, set.map((item) => toValue(zone, item).id === record.id ? toGoDaddy(zone, next) : item));
  }

  async delete(zone: string, record: ProviderRecord): Promise<void> {
    const remaining = (await this.#set(zone, record)).filter((item) => toValue(zone, item).id !== record.id);
    if (remaining.length) await this.#replace(zone, record, remaining);
    else await this.#call("DELETE", `/v1/domains/${zone}/records/${record.type}/${encodeURIComponent(relative(zone, record.name))}`);
  }

  async #set(zone: string, record: DnsValue): Promise<GoDaddyRecord[]> {
    return this.#call<GoDaddyRecord[]>("GET", `/v1/domains/${zone}/records/${record.type}/${encodeURIComponent(relative(zone, record.name))}`);
  }

  async #replace(zone: string, record: DnsValue, set: GoDaddyRecord[]): Promise<void> {
    await this.#call("PUT", `/v1/domains/${zone}/records/${record.type}/${encodeURIComponent(relative(zone, record.name))}`, set);
  }

  async #call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${API}${path}`, {
        method,
        headers: { Authorization: this.#auth, "Content-Type": "application/json", Accept: "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new DnsProviderError("GoDaddy is unreachable", 502);
    }
    const body = await response.json().catch(() => null) as unknown;
    if (response.status === 403) throw new DnsProviderAccessError(ACCESS_MESSAGE);
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : `HTTP ${response.status}`;
      throw new DnsProviderError(response.status === 401 ? `GoDaddy rejected the API key: ${message}` : `GoDaddy: ${message}`);
    }
    return body as T;
  }
}

function relative(zone: string, name: string): string {
  const absoluteName = absolute(name);
  return absoluteName === zone ? "@" : absoluteName.slice(0, -(zone.length + 1));
}

function toValue(zone: string, record: GoDaddyRecord): ProviderRecord {
  const name = record.name === "@" ? zone : `${absolute(record.name)}.${zone}`;
  const value = record.type === "MX" ? `${record.priority ?? 0} ${absolute(record.data)}` : record.type === "CNAME" ? absolute(record.data) : record.data;
  return { id: `${record.type}|${name}|${value}`, type: record.type as DnsValue["type"], name, value };
}

function toGoDaddy(zone: string, record: DnsValue): GoDaddyRecord {
  const name = relative(zone, record.name);
  if (record.type === "MX") {
    const [priority, host] = record.value.split(/\s+/);
    return { type: "MX", name, data: host!, priority: Number(priority), ttl: TTL_SECONDS };
  }
  return { type: record.type, name, data: record.value, ttl: TTL_SECONDS };
}
