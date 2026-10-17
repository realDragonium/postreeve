import { DnsProviderError, absolute, joinTxt, syncedTypes, type DnsProviderClient, type DnsValue, type ProviderRecord } from "./types";

const API = "https://api.cloudflare.com/client/v4";
const TTL_SECONDS = 300;
const COMMENT = "Managed by Postreeve";
const TIMEOUT_MS = 15_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
interface Envelope<T> { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T; result_info?: { total_pages?: number } }
interface CloudflareRecord { id: string; type: string; name: string; content?: string; priority?: number; data?: { priority?: number; weight?: number; port?: number; target?: string } }

/** Cloudflare's v4 API with a scoped API token (Zone:DNS:Edit on the mail domains' zones). */
export class CloudflareDns implements DnsProviderClient {
  readonly label = "Cloudflare";
  readonly types = syncedTypes;
  readonly #token: string;
  readonly #fetch: Fetch;
  #zoneIds: Map<string, string> | null = null;

  constructor(token: string, fetchImpl: Fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async listZones(): Promise<string[]> {
    const zones = await this.#pages<{ id: string; name: string }>("/zones?per_page=50");
    this.#zoneIds = new Map(zones.map((zone) => [absolute(zone.name), zone.id]));
    return [...this.#zoneIds.keys()].sort();
  }

  async listRecords(zone: string): Promise<ProviderRecord[]> {
    const records = await this.#pages<CloudflareRecord>(`/zones/${await this.#zoneId(zone)}/dns_records?per_page=500`);
    return records.filter((record) => this.types.has(record.type)).map((record) => ({
      id: record.id,
      type: record.type as DnsValue["type"],
      name: absolute(record.name),
      value: record.type === "MX" ? `${record.priority ?? 0} ${absolute(record.content ?? "")}`
        : record.type === "SRV" ? `${record.data?.priority ?? 0} ${record.data?.weight ?? 0} ${record.data?.port ?? 0} ${absolute(record.data?.target ?? "")}`
        : record.type === "TXT" ? joinTxt(record.content ?? "")
        : absolute(record.content ?? ""),
    }));
  }

  async create(zone: string, record: DnsValue): Promise<void> {
    await this.#call("POST", `/zones/${await this.#zoneId(zone)}/dns_records`, body(record));
  }

  async update(zone: string, record: ProviderRecord, next: DnsValue): Promise<void> {
    await this.#call("PUT", `/zones/${await this.#zoneId(zone)}/dns_records/${record.id}`, body(next));
  }

  async delete(zone: string, record: ProviderRecord): Promise<void> {
    await this.#call("DELETE", `/zones/${await this.#zoneId(zone)}/dns_records/${record.id}`);
  }

  async #zoneId(zone: string): Promise<string> {
    const id = (this.#zoneIds ?? (await this.listZones(), this.#zoneIds!)).get(absolute(zone));
    if (!id) throw new DnsProviderError(`This Cloudflare token cannot see the zone ${zone}`, 404);
    return id;
  }

  async #pages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const envelope = await this.#call<T[]>("GET", `${path}&page=${page}`);
      items.push(...envelope.result ?? []);
      if (page >= (envelope.result_info?.total_pages ?? 1)) break;
    }
    return items;
  }

  async #call<T>(method: string, path: string, payload?: unknown): Promise<Envelope<T>> {
    let response: Response;
    try {
      response = await this.#fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new DnsProviderError("Cloudflare is unreachable", 502);
    }
    const envelope = await response.json().catch(() => ({})) as Envelope<T>;
    if (!response.ok || envelope.success === false) {
      const message = envelope.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
      throw new DnsProviderError(response.status === 401 || response.status === 403 ? `Cloudflare rejected the API token: ${message}` : `Cloudflare: ${message}`);
    }
    return envelope;
  }
}

function body(record: DnsValue): Record<string, unknown> {
  const base = { type: record.type, name: record.name, ttl: TTL_SECONDS, comment: COMMENT };
  const parts = record.value.split(/\s+/);
  switch (record.type) {
    case "MX": return { ...base, priority: Number(parts[0]), content: parts[1] };
    case "SRV": return { ...base, data: { priority: Number(parts[0]), weight: Number(parts[1]), port: Number(parts[2]), target: parts[3] } };
    case "CNAME": return { ...base, content: record.value, proxied: false };
    case "TXT": return { ...base, content: record.value };
  }
}
