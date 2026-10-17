import { generateKeyPairSync } from "node:crypto";
import type {
  DkimAlgorithm,
  DkimKey,
  MailDomain,
  MailReport,
  Mailbox,
  MailingList,
  QueuedMessage,
  QueuedRecipient,
  SpamListEntry,
  SpamListName,
  SpamSettings,
  UpdateSpamSettingsInput,
} from "../../shared/mail-server";
import { MailServerError, StalwartJmap, type JmapObject } from "./jmap";

const spamNamespaces: Record<SpamListName, string> = { trusted: "trusted-domains", blocked: "blocked-domains" };
// The web UI's own "Retry now" sets the next attempt to this past instant.
const RETRY_NOW = "2000-01-01T00:00:00Z";
const MAX_QUEUE = 500;
const MAX_REPORTS = 200;
const domainProperties = ["name", "aliases", "isEnabled", "catchAllAddress", "dkimManagement"];
const accountProperties = ["name", "domainId", "description", "aliases", "quotas", "usedDiskQuota", "emailAddress", "credentials"];

const keys = (value: unknown): string[] => typeof value === "object" && value !== null ? Object.keys(value) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const nullableText = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const listOf = (value: unknown): JmapObject[] => typeof value === "object" && value !== null ? Object.values(value) as JmapObject[] : [];

export interface StalwartAlias { readonly name: string; readonly domainId: string; readonly enabled: boolean; readonly description: string | null }

/** A mailbox as Stalwart stores it, with the alias objects needed to patch them. */
export interface StalwartMailbox extends Omit<Mailbox, "postreeveAccountId"> {
  readonly localPart: string;
  readonly aliasObjects: readonly StalwartAlias[];
  readonly passwordCredentialKey: string | null;
}

/** Typed admin operations over Stalwart v0.16's JMAP management objects. */
export class StalwartClient {
  readonly jmap: StalwartJmap;

  constructor(jmap: StalwartJmap) {
    this.jmap = jmap;
  }

  async domains(): Promise<MailDomain[]> {
    return (await this.jmap.queryAndGet("Domain", {}, domainProperties)).map(mapDomain)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async domain(id: string): Promise<MailDomain> {
    const [domain] = await this.jmap.get("Domain", [id], domainProperties);
    if (!domain) throw new MailServerError("Domain not found", 404);
    return mapDomain(domain);
  }

  async zoneFile(id: string): Promise<{ name: string; zone: string }> {
    const [domain] = await this.jmap.get("Domain", [id], ["name", "dnsZoneFile"]);
    if (!domain) throw new MailServerError("Domain not found", 404);
    return { name: text(domain.name), zone: text(domain.dnsZoneFile) };
  }

  async createDomain(name: string): Promise<MailDomain> {
    const created = await this.jmap.create("Domain", { name });
    return this.domain(text(created.id));
  }

  async deleteDomain(id: string): Promise<void> {
    await this.jmap.destroy("Domain", [id]);
  }

  async setCatchAll(id: string, address: string | null): Promise<MailDomain> {
    await this.jmap.update("Domain", id, { catchAllAddress: address });
    return this.domain(id);
  }

  async mailboxes(domainId?: string): Promise<StalwartMailbox[]> {
    const filter = { "@type": "User", ...(domainId ? { domainId } : {}) };
    const domains = new Map((await this.domains()).map((domain) => [domain.id, domain.name]));
    return (await this.jmap.queryAndGet("Account", filter, accountProperties))
      // A domain filter still returns accounts whose domain changed; keep the request's intent.
      .filter((account) => !domainId || account.domainId === domainId)
      .map((account) => mapMailbox(account, domains))
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  async mailbox(id: string): Promise<StalwartMailbox> {
    const [account] = await this.jmap.get("Account", [id], accountProperties);
    if (!account) throw new MailServerError("Mailbox not found", 404);
    const domains = new Map((await this.domains()).map((domain) => [domain.id, domain.name]));
    return mapMailbox(account, domains);
  }

  async createMailbox(input: { domainId: string; localPart: string; displayName: string; password: string; quotaBytes: number | null }): Promise<StalwartMailbox> {
    const created = await this.jmap.create("Account", {
      "@type": "User",
      name: input.localPart,
      domainId: input.domainId,
      description: input.displayName || null,
      credentials: { 0: { "@type": "Password", secret: input.password } },
      ...(input.quotaBytes ? { quotas: { maxDiskQuota: input.quotaBytes } } : {}),
    });
    return this.mailbox(text(created.id));
  }

  async updateMailbox(id: string, patch: { displayName?: string | undefined; quotaBytes?: number | null | undefined }): Promise<StalwartMailbox> {
    const update: JmapObject = {};
    if (patch.displayName !== undefined) update.description = patch.displayName || null;
    if (patch.quotaBytes !== undefined) update["quotas/maxDiskQuota"] = patch.quotaBytes;
    if (Object.keys(update).length > 0) await this.jmap.update("Account", id, update);
    return this.mailbox(id);
  }

  async resetPassword(id: string, password: string): Promise<void> {
    const mailbox = await this.mailbox(id);
    if (mailbox.passwordCredentialKey === null) {
      await this.jmap.update("Account", id, { "credentials/0": { "@type": "Password", secret: password } });
    } else {
      await this.jmap.update("Account", id, { [`credentials/${mailbox.passwordCredentialKey}/secret`]: password });
    }
  }

  async setAliases(id: string, aliases: readonly StalwartAlias[]): Promise<StalwartMailbox> {
    await this.jmap.update("Account", id, {
      aliases: Object.fromEntries(aliases.map((alias, index) => [String(index), {
        name: alias.name, domainId: alias.domainId, enabled: alias.enabled, description: alias.description,
      }])),
    });
    return this.mailbox(id);
  }

  async deleteMailbox(id: string): Promise<void> {
    await this.jmap.destroy("Account", [id]);
  }

  /** Creates an app password on the mailbox itself; Stalwart returns the secret this once. */
  async createAppPassword(mailboxId: string, description: string): Promise<{ id: string; secret: string }> {
    const created = await this.jmap.create("AppPassword", { description }, mailboxId);
    const secret = nullableText(created.secret);
    if (!secret) throw new MailServerError("Stalwart did not return the new app password", 502);
    return { id: text(created.id), secret };
  }

  async revokeAppPassword(mailboxId: string, id: string): Promise<void> {
    await this.jmap.destroy("AppPassword", [id], mailboxId);
  }

  async mailingLists(domainId?: string): Promise<MailingList[]> {
    return (await this.jmap.queryAndGet("MailingList", {}, ["name", "domainId", "description", "emailAddress", "recipients"]))
      .filter((list) => !domainId || list.domainId === domainId)
      .map((list) => ({
        id: text(list.id), domainId: text(list.domainId), address: text(list.emailAddress),
        description: text(list.description), recipients: keys(list.recipients).sort(),
      }))
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  async createMailingList(input: { domainId: string; localPart: string; description: string; recipients: readonly string[] }): Promise<MailingList> {
    const created = await this.jmap.create("MailingList", {
      name: input.localPart, domainId: input.domainId, description: input.description || null,
      recipients: Object.fromEntries(input.recipients.map((address) => [address, true])),
    });
    return this.#mailingList(text(created.id));
  }

  async updateMailingList(id: string, patch: { description?: string | undefined; recipients?: readonly string[] | undefined }): Promise<MailingList> {
    const update: JmapObject = {};
    if (patch.description !== undefined) update.description = patch.description || null;
    if (patch.recipients !== undefined) update.recipients = Object.fromEntries(patch.recipients.map((address) => [address, true]));
    if (Object.keys(update).length > 0) await this.jmap.update("MailingList", id, update);
    return this.#mailingList(id);
  }

  async deleteMailingList(id: string): Promise<void> {
    await this.jmap.destroy("MailingList", [id]);
  }

  async #mailingList(id: string): Promise<MailingList> {
    const list = (await this.mailingLists()).find((candidate) => candidate.id === id);
    if (!list) throw new MailServerError("Mailing list not found", 404);
    return list;
  }

  async dkimKeys(domainId: string): Promise<DkimKey[]> {
    return (await this.jmap.queryAndGet("DkimSignature", { domainId }, ["@type", "domainId", "selector", "stage", "publicKey", "createdAt"]))
      .map((key) => ({
        id: text(key.id), domainId: text(key.domainId), algorithm: text(key["@type"]), selector: text(key.selector),
        stage: text(key.stage), publicKey: text(key.publicKey), createdAt: nullableText(key.createdAt),
      }))
      .sort((a, b) => a.selector.localeCompare(b.selector));
  }

  /** Generates the private key here, hands it to Stalwart once and keeps nothing. */
  async generateDkimKey(domainId: string, algorithm: DkimAlgorithm, selector: string): Promise<DkimKey> {
    const { privateKey } = algorithm === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const created = await this.jmap.create("DkimSignature", {
      "@type": algorithm === "rsa" ? "Dkim1RsaSha256" : "Dkim1Ed25519Sha256",
      domainId,
      selector,
      privateKey: { "@type": "Text", secret: pem },
    });
    const key = (await this.dkimKeys(domainId)).find(({ id }) => id === text(created.id));
    if (!key) throw new MailServerError("Stalwart did not keep the new DKIM key", 502);
    return key;
  }

  async deleteDkimKeys(ids: readonly string[]): Promise<void> {
    await this.jmap.destroy("DkimSignature", ids);
  }

  async queue(): Promise<QueuedMessage[]> {
    return (await this.jmap.queryAndGet("QueuedMessage", {}, undefined, MAX_QUEUE)).map((message) => ({
      id: text(message.id),
      from: text(message.returnPath),
      size: count(message.size),
      createdAt: nullableText(message.createdAt),
      nextRetry: nullableText(message.nextRetry),
      recipients: Object.entries((message.recipients ?? {}) as Record<string, JmapObject>).map(([address, recipient]) => mapRecipient(address, recipient)),
    })).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  async retryQueuedMessage(id: string): Promise<void> {
    await this.jmap.update("QueuedMessage", id, { nextRetry: RETRY_NOW });
  }

  async cancelQueuedMessage(id: string): Promise<void> {
    await this.jmap.destroy("QueuedMessage", [id]);
  }

  async reports(): Promise<MailReport[]> {
    const [dmarc, tls] = await Promise.all([
      this.jmap.queryAndGet("DmarcExternalReport", {}, undefined, MAX_REPORTS),
      this.jmap.queryAndGet("TlsExternalReport", {}, undefined, MAX_REPORTS),
    ]);
    return [...dmarc.map(mapDmarcReport), ...tls.map(mapTlsReport)]
      .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
  }

  async spamSettings(): Promise<SpamSettings> {
    const [settings] = await this.jmap.get("SpamSettings", ["singleton"], ["enable", "scoreSpam", "scoreReject", "scoreDiscard"]);
    if (!settings) throw new MailServerError("Stalwart did not return its spam settings", 502);
    return {
      enabled: settings.enable === true,
      spamThreshold: Number(settings.scoreSpam ?? 0),
      rejectThreshold: Number(settings.scoreReject ?? 0),
      discardThreshold: Number(settings.scoreDiscard ?? 0),
    };
  }

  async updateSpamSettings(input: UpdateSpamSettingsInput): Promise<SpamSettings> {
    const patch: JmapObject = {};
    if (input.enabled !== undefined) patch.enable = input.enabled;
    if (input.spamThreshold !== undefined) patch.scoreSpam = input.spamThreshold;
    if (input.rejectThreshold !== undefined) patch.scoreReject = input.rejectThreshold;
    if (input.discardThreshold !== undefined) patch.scoreDiscard = input.discardThreshold;
    if (Object.keys(patch).length > 0) {
      await this.jmap.update("SpamSettings", "singleton", patch);
      await this.reload("ReloadSettings");
    }
    return this.spamSettings();
  }

  async spamList(list: SpamListName): Promise<SpamListEntry[]> {
    return (await this.jmap.queryAndGet("MemoryLookupKey", { namespace: spamNamespaces[list] }, ["key"]))
      .map((entry) => ({ id: text(entry.id), domain: text(entry.key) }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  async addSpamListEntry(list: SpamListName, domain: string): Promise<SpamListEntry> {
    const created = await this.jmap.create("MemoryLookupKey", { namespace: spamNamespaces[list], key: domain, isGlobPattern: false });
    await this.reload("ReloadLookupStores");
    return { id: text(created.id), domain };
  }

  async removeSpamListEntry(list: SpamListName, id: string): Promise<void> {
    const [entry] = await this.jmap.get("MemoryLookupKey", [id], ["namespace"]);
    if (!entry || entry.namespace !== spamNamespaces[list]) throw new MailServerError("Entry not found in that list", 404);
    await this.jmap.destroy("MemoryLookupKey", [id]);
    await this.reload("ReloadLookupStores");
  }

  /** Stored settings take effect only after a reload; data objects such as domains and accounts do not need one. */
  async reload(action: "ReloadSettings" | "ReloadLookupStores"): Promise<void> {
    try {
      await this.jmap.create("Action", { "@type": action });
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/^.*could not create the Action: /, "") : "unknown reason";
      throw new MailServerError(`Saved in Stalwart, but it could not apply the change yet: ${reason}. Fix that in Stalwart's admin, then reload its settings there.`, 409);
    }
  }
}

function mapDomain(domain: JmapObject): MailDomain {
  return {
    id: text(domain.id),
    name: text(domain.name),
    enabled: domain.isEnabled !== false,
    aliases: keys(domain.aliases).sort(),
    catchAll: nullableText(domain.catchAllAddress),
    dkimManagement: (domain.dkimManagement as JmapObject | undefined)?.["@type"] === "Manual" ? "manual" : "automatic",
  };
}

function mapMailbox(account: JmapObject, domains: ReadonlyMap<string, string>): StalwartMailbox {
  const aliasObjects = listOf(account.aliases).map((alias) => ({
    name: text(alias.name), domainId: text(alias.domainId), enabled: alias.enabled !== false, description: nullableText(alias.description),
  }));
  const passwordCredentialKey = Object.entries((account.credentials ?? {}) as Record<string, JmapObject>)
    .find(([, credential]) => credential["@type"] === "Password")?.[0] ?? null;
  const domainName = domains.get(text(account.domainId)) ?? "";
  const quota = (account.quotas as JmapObject | undefined)?.maxDiskQuota;
  return {
    id: text(account.id),
    domainId: text(account.domainId),
    localPart: text(account.name),
    address: text(account.emailAddress) || `${text(account.name)}@${domainName}`,
    displayName: text(account.description),
    aliases: aliasObjects.map((alias) => ({ address: `${alias.name}@${domains.get(alias.domainId) ?? "?"}`, enabled: alias.enabled })),
    aliasObjects,
    quotaBytes: typeof quota === "number" && quota > 0 ? quota : null,
    usedBytes: count(account.usedDiskQuota),
    passwordCredentialKey,
  };
}

function mapRecipient(address: string, recipient: JmapObject): QueuedRecipient {
  const status = (recipient.status ?? {}) as JmapObject;
  const type = text(status["@type"]);
  const kind = type === "Completed" ? "completed" : type === "TemporaryFailure" ? "temporaryFailure"
    : type === "PermanentFailure" ? "permanentFailure" : "scheduled";
  const reason = [status.responseCode, status.responseEnhanced, status.responseMessage ?? status.errorMessage]
    .filter((part) => part !== null && part !== undefined && part !== "").join(" ");
  return {
    address,
    status: kind,
    retryCount: count(recipient.retryCount),
    retryDue: nullableText(recipient.retryDue),
    lastError: kind === "temporaryFailure" || kind === "permanentFailure" ? (reason || text(status.errorType) || null) : null,
  };
}

function mapDmarcReport(entry: JmapObject): MailReport {
  const report = (entry.report ?? {}) as JmapObject;
  let pass = 0;
  let fail = 0;
  for (const record of listOf(report.records)) {
    const messages = count(record.count);
    // DMARC passes when either aligned DKIM or aligned SPF passes.
    if (record.evaluatedDkim === "pass" || record.evaluatedSpf === "pass") pass += messages;
    else fail += messages;
  }
  return {
    kind: "dmarc", id: text(entry.id), from: text(entry.from), subject: text(entry.subject), receivedAt: nullableText(entry.receivedAt),
    reporter: text(report.orgName) || text(report.email), domain: text(report.policyDomain),
    rangeStart: nullableText(report.dateRangeBegin), rangeEnd: nullableText(report.dateRangeEnd), pass, fail,
  };
}

function mapTlsReport(entry: JmapObject): MailReport {
  const report = (entry.report ?? {}) as JmapObject;
  const policies = listOf(report.policies);
  return {
    kind: "tls", id: text(entry.id), from: text(entry.from), subject: text(entry.subject), receivedAt: nullableText(entry.receivedAt),
    reporter: text(report.organizationName) || text(entry.from), domain: policies.map((policy) => text(policy.policyDomain)).filter(Boolean).join(", "),
    rangeStart: nullableText(report.dateRangeStart), rangeEnd: nullableText(report.dateRangeEnd),
    pass: policies.reduce((total, policy) => total + count(policy.totalSuccessfulSessions), 0),
    fail: policies.reduce((total, policy) => total + count(policy.totalFailedSessions), 0),
  };
}
