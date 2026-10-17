/** A DNS record in Postreeve's provider-neutral form. */
export interface DnsValue {
  readonly type: "MX" | "TXT" | "CNAME" | "SRV";
  /** Absolute, lowercase, without the trailing dot. */
  readonly name: string;
  /** Presentation form: `10 mail.example.org` (MX), `0 1 993 mail.example.org` (SRV), raw text (TXT), a host (CNAME). */
  readonly value: string;
}

export interface ProviderRecord extends DnsValue {
  readonly id: string;
}

export const syncedTypes = new Set<string>(["MX", "TXT", "CNAME", "SRV"]);

export interface DnsProviderClient {
  readonly label: string;
  /** Record types this provider client can write; the rest are left to the checklist. */
  readonly types: ReadonlySet<string>;
  listZones(): Promise<string[]>;
  listRecords(zone: string): Promise<ProviderRecord[]>;
  create(zone: string, record: DnsValue): Promise<void>;
  update(zone: string, record: ProviderRecord, next: DnsValue): Promise<void>;
  delete(zone: string, record: ProviderRecord): Promise<void>;
}

export class DnsProviderError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(message: string, status: DnsProviderError["status"] = 400) {
    super(message);
    this.name = "DnsProviderError";
    this.status = status;
  }
}

/** The provider refuses API access for this account (GoDaddy's 2024 restriction); fall back to the checklist. */
export class DnsProviderAccessError extends DnsProviderError {
  constructor(message: string) {
    super(message, 409);
    this.name = "DnsProviderAccessError";
  }
}

export const absolute = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

/** Normalizes a value for comparison: hosts lose the trailing dot and case, TXT whitespace collapses. */
export function normalizeValue(type: string, value: string): string {
  if (type === "TXT") return value.replace(/\s+/g, " ").trim();
  return value.trim().split(/\s+/).map((part, index, parts) => index === parts.length - 1 ? absolute(part) : part).join(" ");
}

/** Joins quoted TXT strings (`"a" "b"` → `ab`); unquoted text passes through. */
export function joinTxt(value: string): string {
  const parts = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1]!.replace(/\\(.)/g, "$1"));
  return parts.length ? parts.join("") : value;
}

export const recordKey = (record: DnsValue) => `${record.type}|${absolute(record.name)}|${normalizeValue(record.type, record.value)}`;
