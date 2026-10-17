import {
  applyDnsPlanInputSchema,
  connectDnsProviderInputSchema,
  dnsProviderCredentialSchema,
  type ApplyDnsPlanInput,
  type ConnectDnsProviderInput,
  type DnsApplyResult,
  type DnsPlan,
  type DnsProvider,
  type DnsProviderCredential,
  type DnsProviderSummary,
} from "../../shared/dns-providers";
import type { DnsRecord } from "../../shared/mail-server";
import type { SecretVault } from "../stalwart/service";
import { CloudflareDns } from "./cloudflare";
import { GoDaddyDns } from "./godaddy";
import { planChanges, type Plan } from "./plan";
import type { DnsProviderStore, StoredDnsProvider } from "./store";
import { DnsProviderAccessError, DnsProviderError, absolute, recordKey, type DnsProviderClient, type DnsValue } from "./types";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Where the required records of a mail server domain come from (the Stalwart zone). */
export interface RequiredRecordsSource {
  requiredDnsRecords(serverId: string, domainId: string): Promise<{ domain: string; records: DnsRecord[] }>;
}

export interface DnsProvidersOptions {
  readonly store: DnsProviderStore;
  readonly vault: SecretVault;
  readonly records: RequiredRecordsSource;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

interface Resolved {
  readonly domain: string;
  readonly provider: StoredDnsProvider | null;
  readonly client: DnsProviderClient | null;
  readonly zone: string | null;
  readonly required: DnsValue[];
  readonly manual: DnsRecord[];
  readonly plan: Plan | null;
  readonly reason: string | null;
  readonly status: DnsPlan["status"];
}

const message = (error: unknown) => error instanceof Error ? error.message : "Unknown failure";

export class DnsProviders {
  readonly #store: DnsProviderStore;
  readonly #vault: SecretVault;
  readonly #records: RequiredRecordsSource;
  readonly #fetch: Fetch;
  readonly #now: () => Date;

  constructor(options: DnsProvidersOptions) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#records = options.records;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async list(): Promise<DnsProviderSummary[]> {
    return Promise.all(this.#store.list().map(async (provider) => {
      try {
        return { ...publicProvider(provider), zones: await this.#client(provider).listZones(), error: null };
      } catch (error) {
        return { ...publicProvider(provider), zones: null, error: message(error) };
      }
    }));
  }

  async connect(raw: ConnectDnsProviderInput): Promise<DnsProvider> {
    const input = connectDnsProviderInputSchema.parse(raw);
    await this.#clientFor(input.credential).listZones();
    const provider: StoredDnsProvider = {
      id: crypto.randomUUID(), name: input.name, kind: input.credential.kind, createdAt: this.#now().toISOString(),
      encryptedCredential: this.#vault.encryptSecret(JSON.stringify(input.credential)),
    };
    this.#store.insert(provider);
    return publicProvider(provider);
  }

  disconnect(id: string): void {
    if (!this.#store.get(id)) throw new DnsProviderError("DNS provider not found", 404);
    this.#store.delete(id);
  }

  async plan(serverId: string, domainId: string): Promise<DnsPlan> {
    return publicPlan(await this.#resolve(serverId, domainId));
  }

  /** Applies the owner's selection, only if the zone still matches the plan they reviewed. */
  async apply(serverId: string, domainId: string, raw: ApplyDnsPlanInput): Promise<DnsApplyResult> {
    const input = applyDnsPlanInputSchema.parse(raw);
    const resolved = await this.#resolve(serverId, domainId);
    if (!resolved.plan) throw new DnsProviderError(resolved.reason ?? "No DNS provider can change this domain", 409);
    if (resolved.plan.fingerprint !== input.fingerprint) {
      throw new DnsProviderError("The DNS records changed since you reviewed them; review the changes again", 409);
    }
    const known = new Set(resolved.plan.changes.map(({ id }) => id));
    const unknown = input.changeIds.filter((id) => !known.has(id));
    if (unknown.length) throw new DnsProviderError("The selection contains changes that are not in the current plan; review the changes again", 409);
    return this.#execute(resolved, new Set(input.changeIds));
  }

  /** For an approved agent proposal: a fresh plan, applying only what is selected by default. */
  async applyDefaults(serverId: string, domainId: string): Promise<DnsApplyResult> {
    const resolved = await this.#resolve(serverId, domainId);
    if (!resolved.plan) throw new DnsProviderError(resolved.reason ?? "No DNS provider can change this domain", 409);
    return this.#execute(resolved, new Set(resolved.plan.changes.filter(({ selected }) => selected).map(({ id }) => id)));
  }

  async #execute(resolved: Resolved, selected: ReadonlySet<string>): Promise<DnsApplyResult> {
    const { provider, client, zone, plan } = resolved;
    const results: DnsApplyResult["results"] = [];
    const now = this.#now().toISOString();
    for (const change of plan!.changes.filter(({ id }) => selected.has(id))) {
      try {
        if (change.action === "create") {
          await client!.create(zone!, change.next!);
          this.#store.own(provider!.id, zone!, recordKey(change.next!), now);
        } else if (change.action === "update") {
          await client!.update(zone!, change.record!, change.next!);
          // Updating someone else's record does not make it Postreeve's.
          if (change.owned) {
            this.#store.disown(provider!.id, zone!, recordKey(change.record!));
            this.#store.own(provider!.id, zone!, recordKey(change.next!), now);
          }
        } else {
          await client!.delete(zone!, change.record!);
          this.#store.disown(provider!.id, zone!, recordKey(change.record!));
        }
        results.push({ id: change.id, ok: true, message: `${capitalize(change.action)}d ${change.type} ${change.name}` });
      } catch (error) {
        results.push({ id: change.id, ok: false, message: message(error) });
      }
    }
    return { domain: resolved.domain, results };
  }

  async #resolve(serverId: string, domainId: string): Promise<Resolved> {
    const { domain, records } = await this.#records.requiredDnsRecords(serverId, domainId);
    const base = { domain, provider: null, client: null, zone: null, plan: null };
    const all = records.map((record) => ({ record, value: toValue(record) }));
    let match: { provider: StoredDnsProvider; client: DnsProviderClient; zone: string } | null = null;
    const errors: string[] = [];
    for (const provider of this.#store.list()) {
      const client = this.#client(provider);
      try {
        const zone = (await client.listZones()).filter((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
          .sort((a, b) => b.length - a.length)[0];
        if (zone && (!match || zone.length > match.zone.length)) match = { provider, client, zone };
      } catch (error) {
        errors.push(`${provider.name}: ${message(error)}`);
      }
    }
    if (!match) {
      const reason = errors.length ? `No connected DNS provider has a zone for ${domain} (${errors.join("; ")})` : `No connected DNS provider has a zone for ${domain}`;
      return { ...base, required: [], manual: records, reason, status: "no-provider" };
    }
    const required = all.flatMap(({ value }) => value && match.client.types.has(value.type) ? [value] : []);
    const manual = all.flatMap(({ record, value }) => value && match.client.types.has(value.type) ? [] : [record]);
    try {
      const current = await match.client.listRecords(match.zone);
      const plan = planChanges(required, current, this.#store.owned(match.provider.id, match.zone));
      return { ...base, ...match, required, manual, plan, reason: null, status: "ready" };
    } catch (error) {
      if (error instanceof DnsProviderAccessError) return { ...base, ...match, required, manual: records, reason: error.message, status: "unavailable" };
      throw error;
    }
  }

  #client(provider: StoredDnsProvider): DnsProviderClient {
    return this.#clientFor(dnsProviderCredentialSchema.parse(JSON.parse(this.#vault.decryptSecret(provider.encryptedCredential))));
  }

  #clientFor(credential: DnsProviderCredential): DnsProviderClient {
    return credential.kind === "cloudflare"
      ? new CloudflareDns(credential.apiToken, this.#fetch)
      : new GoDaddyDns(credential.apiKey, credential.apiSecret, this.#fetch);
  }
}

function toValue(record: DnsRecord): DnsValue | null {
  if (record.type !== "MX" && record.type !== "TXT" && record.type !== "CNAME" && record.type !== "SRV") return null;
  return { type: record.type, name: absolute(record.name), value: record.type === "TXT" ? record.value : record.value.split(/\s+/).map((part, index, parts) => index === parts.length - 1 ? absolute(part) : part).join(" ") };
}

function publicProvider(provider: StoredDnsProvider): DnsProvider {
  const { encryptedCredential: _secret, ...rest } = provider;
  return rest;
}

function publicPlan(resolved: Resolved): DnsPlan {
  return {
    domain: resolved.domain,
    status: resolved.status,
    providerId: resolved.provider?.id ?? null,
    providerName: resolved.provider?.name ?? null,
    zone: resolved.zone,
    reason: resolved.reason,
    fingerprint: resolved.plan?.fingerprint ?? "",
    inSync: resolved.plan?.inSync ?? 0,
    changes: (resolved.plan?.changes ?? []).map(({ record: _record, next: _next, ...change }) => change),
    manual: resolved.manual,
  };
}

const capitalize = (action: string) => action === "create" ? "Create" : action === "update" ? "Update" : "Delete";
