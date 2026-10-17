import { isIP } from "node:net";
import type { Account, CreateAccountInput, CreateIdentityInput, Identity } from "../../shared/contracts";
import { createIdentityInputSchema } from "../../shared/contracts";
import {
  aliasInputSchema,
  approveMailServerProposalInputSchema,
  catchAllInputSchema,
  confirmInputSchema,
  connectMailServerInputSchema,
  createMailServerProposalInputSchema,
  createMailboxInputSchema,
  createMailingListInputSchema,
  generateDkimInputSchema,
  mailServerCredentialSchema,
  requiredConfirmations,
  resetPasswordInputSchema,
  spamListEntryInputSchema,
  updateMailServerInputSchema,
  updateMailboxInputSchema,
  updateMailingListInputSchema,
  updateSpamSettingsInputSchema,
  type AliasResult,
  type ApproveMailServerProposalInput,
  type CatchAllResult,
  type ConnectMailServerInput,
  type CreateMailServerProposalInput,
  type CreateMailboxInput,
  type CreateMailboxResult,
  type CreateMailingListInput,
  type DkimKey,
  type DnsChecklist,
  type IdentityRegistration,
  type MailDomain,
  type MailReport,
  type MailServer,
  type MailServerCredential,
  type MailServerOperation,
  type MailServerProposal,
  type MailServerSummary,
  type Mailbox,
  type MailingList,
  type PostreeveAccountLink,
  type QueuedMessage,
  type SpamListEntry,
  type SpamListName,
  type SpamSettings,
  type UpdateMailServerInput,
  type UpdateMailboxInput,
  type UpdateMailingListInput,
} from "../../shared/mail-server";
import { StalwartClient, type StalwartMailbox } from "./client";
import { checkRecords, parseZoneFile, type DnsLookup } from "./dns";
import { MailServerError, StalwartJmap, type JmapFetch } from "./jmap";
import type { MailServerStore, StoredMailServer } from "./store";

/** The parts of Postreeve's account service the mail server area uses. */
export interface PostreeveAccountsPort {
  listAccounts(): Promise<Account[]>;
  createAccount(input: CreateAccountInput): Promise<Account>;
  listIdentities(accountId: string): Promise<Identity[]>;
  addIdentity(accountId: string, input: CreateIdentityInput): Promise<{ identity: Identity; created: boolean }>;
}

export interface SecretVault {
  encryptSecret(plaintext: string): string;
  decryptSecret(value: string): string;
}

export interface MailServerAdminOptions {
  readonly store: MailServerStore;
  readonly vault: SecretVault;
  readonly accounts: PostreeveAccountsPort;
  readonly dns: DnsLookup;
  readonly fetch?: JmapFetch;
  readonly now?: () => Date;
}

const APP_PASSWORD_NAME = "Postreeve";
const IMAP_PORT = 993;
const SMTP_PORT = 465;

/** Admin URLs may use plain HTTP only where the network path is already private. */
export function normalizeAdminUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MailServerError("Enter the admin URL, for example https://mail-admin.example.ts.net");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new MailServerError("The admin URL must start with https://");
  if (url.username || url.password) throw new MailServerError("Put the credential in its own field, not in the URL");
  if (url.search || url.hash) throw new MailServerError("The admin URL must not have a query or fragment");
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new MailServerError("The admin URL must use HTTPS unless it is a loopback, private-network or Tailscale address");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".ts.net") || !host.includes(".") && isIP(host) === 0) return true;
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fd7a:115c:a1e0:");
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function splitAddress(address: string): { localPart: string; domain: string } {
  const at = address.lastIndexOf("@");
  return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
}

const message = (error: unknown) => error instanceof Error ? error.message : "Unknown failure";

export class MailServerAdmin {
  readonly #store: MailServerStore;
  readonly #vault: SecretVault;
  readonly #accounts: PostreeveAccountsPort;
  readonly #dns: DnsLookup;
  readonly #fetch: JmapFetch;
  readonly #now: () => Date;

  constructor(options: MailServerAdminOptions) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#accounts = options.accounts;
    this.#dns = options.dns;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  // Servers

  async listServers(): Promise<MailServerSummary[]> {
    return Promise.all(this.#store.listServers().map(async (server) => {
      try {
        return { ...publicServer(server), domainCount: (await this.#client(server).jmap.query("Domain")).length, error: null };
      } catch (error) {
        return { ...publicServer(server), domainCount: null, error: message(error) };
      }
    }));
  }

  async connect(raw: ConnectMailServerInput): Promise<MailServer> {
    const input = connectMailServerInputSchema.parse(raw);
    const baseUrl = normalizeAdminUrl(input.baseUrl);
    const { publicHost } = await this.#verify({ name: input.name, baseUrl, credential: input.credential });
    const now = this.#now().toISOString();
    const server: StoredMailServer = {
      id: crypto.randomUUID(), name: input.name, baseUrl, credentialKind: input.credential.kind,
      mailHostname: input.mailHostname ?? publicHost ?? new URL(baseUrl).hostname,
      createdAt: now, updatedAt: now, encryptedCredential: this.#vault.encryptSecret(JSON.stringify(input.credential)),
    };
    this.#store.insertServer(server);
    return publicServer(server);
  }

  async updateServer(id: string, raw: UpdateMailServerInput): Promise<MailServer> {
    const input = updateMailServerInputSchema.parse(raw);
    const server = this.#server(id);
    if (input.credential) await this.#verify({ name: input.name ?? server.name, baseUrl: server.baseUrl, credential: input.credential });
    const updated: StoredMailServer = {
      ...server,
      name: input.name ?? server.name,
      mailHostname: input.mailHostname ?? server.mailHostname,
      credentialKind: input.credential?.kind ?? server.credentialKind,
      encryptedCredential: input.credential ? this.#vault.encryptSecret(JSON.stringify(input.credential)) : server.encryptedCredential,
      updatedAt: this.#now().toISOString(),
    };
    this.#store.updateServer(updated);
    return publicServer(updated);
  }

  disconnect(id: string): void {
    this.#server(id);
    this.#store.deleteServer(id);
  }

  // Domains

  domains(serverId: string): Promise<MailDomain[]> {
    return this.#clientFor(serverId).domains();
  }

  addDomain(serverId: string, name: string): Promise<MailDomain> {
    return this.#clientFor(serverId).createDomain(name);
  }

  async deleteDomain(serverId: string, domainId: string, raw: unknown): Promise<void> {
    const { confirm } = confirmInputSchema.parse(raw);
    const client = this.#clientFor(serverId);
    const domain = await client.domain(domainId);
    if (confirm !== domain.name) throw new MailServerError(`Type ${domain.name} to confirm deleting the domain`);
    await this.#deleteDomain(client, domain);
  }

  async #deleteDomain(client: StalwartClient, domain: MailDomain): Promise<void> {
    const accounts = (await client.jmap.queryAndGet("Account", { domainId: domain.id }, ["domainId"]))
      .filter((account) => account.domainId === domain.id).length;
    const lists = (await client.mailingLists(domain.id)).length;
    if (accounts || lists) {
      const parts = [accounts ? `${accounts} mailbox${accounts === 1 ? "" : "es"}` : "", lists ? `${lists} mailing list${lists === 1 ? "" : "s"}` : ""];
      throw new MailServerError(`${parts.filter(Boolean).join(" and ")} still use${accounts + lists === 1 ? "s" : ""} ${domain.name}; delete them first`, 409);
    }
    await client.deleteDkimKeys((await client.dkimKeys(domain.id)).map(({ id }) => id));
    await client.deleteDomain(domain.id);
  }

  async setCatchAll(serverId: string, domainId: string, raw: unknown): Promise<CatchAllResult> {
    const { address } = catchAllInputSchema.parse(raw);
    const client = this.#clientFor(serverId);
    if (address !== null && !(await this.#knownAddresses(client)).has(address)) {
      throw new MailServerError(`${address} is not a mailbox, alias or mailing list on this server`);
    }
    const domain = await client.setCatchAll(domainId, address);
    const identity = address === null ? null : await this.#registerIdentity(address, `*@${domain.name}`, null);
    return { domain, identity };
  }

  async dnsChecklist(serverId: string, domainId: string): Promise<DnsChecklist> {
    const { name, zone } = await this.#clientFor(serverId).zoneFile(domainId);
    const records = parseZoneFile(zone, name);
    return { domain: name, zone, resolver: this.#dns.label, checkedAt: this.#now().toISOString(), records: await checkRecords(records, this.#dns) };
  }

  // Mailboxes

  async mailboxes(serverId: string, domainId?: string): Promise<Mailbox[]> {
    const [mailboxes, accounts] = await Promise.all([this.#clientFor(serverId).mailboxes(domainId), this.#accounts.listAccounts()]);
    return mailboxes.map((mailbox) => this.#public(mailbox, accounts));
  }

  async createMailbox(serverId: string, raw: CreateMailboxInput): Promise<CreateMailboxResult> {
    const input = createMailboxInputSchema.parse(raw);
    const client = this.#clientFor(serverId);
    const created = await client.createMailbox(input);
    const account = input.addToPostreeve ? await this.#addToPostreeve(serverId, client, created) : notRequested;
    return { mailbox: this.#public(created, await this.#accounts.listAccounts()), account };
  }

  async addMailboxToPostreeve(serverId: string, mailboxId: string): Promise<CreateMailboxResult> {
    const client = this.#clientFor(serverId);
    const mailbox = await client.mailbox(mailboxId);
    const account = await this.#addToPostreeve(serverId, client, mailbox);
    return { mailbox: this.#public(mailbox, await this.#accounts.listAccounts()), account };
  }

  async updateMailbox(serverId: string, mailboxId: string, raw: UpdateMailboxInput): Promise<Mailbox> {
    const input = updateMailboxInputSchema.parse(raw);
    return this.#public(await this.#clientFor(serverId).updateMailbox(mailboxId, input), await this.#accounts.listAccounts());
  }

  async resetPassword(serverId: string, mailboxId: string, raw: unknown): Promise<void> {
    const { password } = resetPasswordInputSchema.parse(raw);
    await this.#clientFor(serverId).resetPassword(mailboxId, password);
  }

  async addAlias(serverId: string, mailboxId: string, raw: unknown): Promise<AliasResult> {
    const { address } = aliasInputSchema.parse(raw);
    const client = this.#clientFor(serverId);
    const mailbox = await client.mailbox(mailboxId);
    const { localPart, domain: domainName } = splitAddress(address);
    const domain = (await client.domains()).find(({ name }) => name === domainName);
    if (!domain) throw new MailServerError(`${domainName} is not a domain on this server`);
    if (mailbox.aliases.some((alias) => alias.address === address) || mailbox.address === address) {
      throw new MailServerError(`${address} is already an address of this mailbox`, 409);
    }
    const updated = await client.setAliases(mailboxId, [...mailbox.aliasObjects, { name: localPart, domainId: domain.id, enabled: true, description: null }]);
    const identity = await this.#registerIdentity(updated.address, address, updated.displayName || null);
    return { mailbox: this.#public(updated, await this.#accounts.listAccounts()), identity };
  }

  async removeAlias(serverId: string, mailboxId: string, raw: unknown): Promise<Mailbox> {
    const { address } = aliasInputSchema.parse(raw);
    const client = this.#clientFor(serverId);
    const mailbox = await client.mailbox(mailboxId);
    const index = mailbox.aliases.findIndex((alias) => alias.address === address);
    if (index < 0) throw new MailServerError(`${address} is not an alias of this mailbox`, 404);
    const updated = await client.setAliases(mailboxId, mailbox.aliasObjects.filter((_, position) => position !== index));
    return this.#public(updated, await this.#accounts.listAccounts());
  }

  async deleteMailbox(serverId: string, mailboxId: string, raw: unknown): Promise<void> {
    const { confirm } = confirmInputSchema.parse(raw);
    const client = this.#clientFor(serverId);
    const mailbox = await client.mailbox(mailboxId);
    if (confirm !== mailbox.address.toLowerCase()) throw new MailServerError(`Type ${mailbox.address} to confirm deleting the mailbox`);
    await client.deleteMailbox(mailboxId);
  }

  // Mailing lists

  mailingLists(serverId: string, domainId?: string): Promise<MailingList[]> {
    return this.#clientFor(serverId).mailingLists(domainId);
  }

  createMailingList(serverId: string, raw: CreateMailingListInput): Promise<MailingList> {
    return this.#clientFor(serverId).createMailingList(createMailingListInputSchema.parse(raw));
  }

  updateMailingList(serverId: string, listId: string, raw: UpdateMailingListInput): Promise<MailingList> {
    return this.#clientFor(serverId).updateMailingList(listId, updateMailingListInputSchema.parse(raw));
  }

  deleteMailingList(serverId: string, listId: string): Promise<void> {
    return this.#clientFor(serverId).deleteMailingList(listId);
  }

  // DKIM

  dkimKeys(serverId: string, domainId: string): Promise<DkimKey[]> {
    return this.#clientFor(serverId).dkimKeys(domainId);
  }

  generateDkimKey(serverId: string, domainId: string, raw: unknown): Promise<DkimKey> {
    const input = generateDkimInputSchema.parse(raw);
    return this.#clientFor(serverId).generateDkimKey(domainId, input.algorithm, input.selector);
  }

  deleteDkimKey(serverId: string, keyId: string): Promise<void> {
    return this.#clientFor(serverId).deleteDkimKeys([keyId]);
  }

  // Queue, reports, spam

  queue(serverId: string): Promise<QueuedMessage[]> {
    return this.#clientFor(serverId).queue();
  }

  retryQueuedMessage(serverId: string, id: string): Promise<void> {
    return this.#clientFor(serverId).retryQueuedMessage(id);
  }

  cancelQueuedMessage(serverId: string, id: string): Promise<void> {
    return this.#clientFor(serverId).cancelQueuedMessage(id);
  }

  reports(serverId: string): Promise<MailReport[]> {
    return this.#clientFor(serverId).reports();
  }

  spamSettings(serverId: string): Promise<SpamSettings> {
    return this.#clientFor(serverId).spamSettings();
  }

  updateSpamSettings(serverId: string, raw: unknown): Promise<SpamSettings> {
    return this.#clientFor(serverId).updateSpamSettings(updateSpamSettingsInputSchema.parse(raw));
  }

  spamList(serverId: string, list: SpamListName): Promise<SpamListEntry[]> {
    return this.#clientFor(serverId).spamList(list);
  }

  addSpamListEntry(serverId: string, list: SpamListName, raw: unknown): Promise<SpamListEntry> {
    return this.#clientFor(serverId).addSpamListEntry(list, spamListEntryInputSchema.parse(raw).domain);
  }

  removeSpamListEntry(serverId: string, list: SpamListName, id: string): Promise<void> {
    return this.#clientFor(serverId).removeSpamListEntry(list, id);
  }

  // Proposals: anyone may prepare one; only the human-facing routes call approve and reject.

  createProposal(serverId: string, raw: CreateMailServerProposalInput, createdBy: string): MailServerProposal {
    const input = createMailServerProposalInputSchema.parse(raw);
    this.#server(serverId);
    const proposal: MailServerProposal = {
      id: crypto.randomUUID(), serverId, title: input.title, createdBy: createdBy.slice(0, 120) || "agent",
      operations: input.operations, status: "pending", results: [], createdAt: this.#now().toISOString(), decidedAt: null,
    };
    this.#store.insertProposal(proposal);
    return proposal;
  }

  listProposals(serverId?: string): MailServerProposal[] {
    return this.#store.listProposals(serverId);
  }

  rejectProposal(id: string): MailServerProposal {
    this.#proposal(id);
    if (!this.#store.transitionProposal(id, "pending", "rejected", [], this.#now().toISOString())) {
      throw new MailServerError("Only a pending proposal can be rejected", 409);
    }
    return this.#proposal(id);
  }

  async approveProposal(id: string, raw: ApproveMailServerProposalInput): Promise<MailServerProposal> {
    const input = approveMailServerProposalInputSchema.parse(raw);
    const proposal = this.#proposal(id);
    if (proposal.status !== "pending") throw new MailServerError("Only a pending proposal can be approved", 409);
    const missing = requiredConfirmations(proposal.operations).filter((name) => !input.confirmations.includes(name));
    if (missing.length) throw new MailServerError(`Type ${missing.join(", ")} to confirm the deletion${missing.length === 1 ? "" : "s"}`);
    const withoutPassword = proposal.operations.flatMap((operation, index) =>
      operation.type === "createMailbox" && !input.passwords[String(index)] ? [operation.address] : []);
    if (withoutPassword.length) throw new MailServerError(`Set a password for ${withoutPassword.join(", ")}`);
    if (!this.#store.transitionProposal(id, "pending", "applying", [], null)) {
      throw new MailServerError("This proposal was already decided", 409);
    }

    const results: MailServerProposal["results"] = [];
    const client = this.#clientFor(proposal.serverId);
    for (const [index, operation] of proposal.operations.entries()) {
      try {
        results.push({ index, ok: true, message: await this.#apply(proposal.serverId, client, operation, input.passwords[String(index)]) });
      } catch (error) {
        results.push({ index, ok: false, message: message(error) });
        break;
      }
    }
    const ok = results.length === proposal.operations.length && results.every((result) => result.ok);
    this.#store.transitionProposal(id, "applying", ok ? "applied" : "failed", results, this.#now().toISOString());
    return this.#proposal(id);
  }

  async #apply(serverId: string, client: StalwartClient, operation: MailServerOperation, password: string | undefined): Promise<string> {
    const domainByName = async (name: string) => {
      const domain = (await client.domains()).find((candidate) => candidate.name === name);
      if (!domain) throw new MailServerError(`${name} is not a domain on this server`, 404);
      return domain;
    };
    const mailboxByAddress = async (address: string) => {
      const mailbox = (await client.mailboxes()).find((candidate) => candidate.address.toLowerCase() === address);
      if (!mailbox) throw new MailServerError(`${address} is not a mailbox on this server`, 404);
      return mailbox;
    };
    const listByAddress = async (address: string) => {
      const list = (await client.mailingLists()).find((candidate) => candidate.address.toLowerCase() === address);
      if (!list) throw new MailServerError(`${address} is not a mailing list on this server`, 404);
      return list;
    };
    switch (operation.type) {
      case "addDomain":
        await client.createDomain(operation.domain);
        return `Added ${operation.domain}`;
      case "deleteDomain":
        await this.#deleteDomain(client, await domainByName(operation.domain));
        return `Deleted ${operation.domain}`;
      case "createMailbox": {
        const { localPart, domain } = splitAddress(operation.address);
        const result = await this.createMailbox(serverId, {
          domainId: (await domainByName(domain)).id, localPart, displayName: operation.displayName,
          password: password ?? "", quotaBytes: operation.quotaBytes, addToPostreeve: operation.addToPostreeve,
        });
        return result.account.status === "failed"
          ? `Created ${operation.address}; not added to Postreeve: ${result.account.reason}`
          : `Created ${operation.address}${result.account.status === "added" ? " and added it to Postreeve" : ""}`;
      }
      case "updateMailbox":
        await client.updateMailbox((await mailboxByAddress(operation.address)).id, operation);
        return `Updated ${operation.address}`;
      case "deleteMailbox":
        await client.deleteMailbox((await mailboxByAddress(operation.address)).id);
        return `Deleted ${operation.address}`;
      case "addAlias": {
        const result = await this.addAlias(serverId, (await mailboxByAddress(operation.address)).id, { address: operation.alias });
        return `Added ${operation.alias} to ${operation.address}${result.identity?.status === "registered" ? " and registered the identity" : ""}`;
      }
      case "removeAlias":
        await this.removeAlias(serverId, (await mailboxByAddress(operation.address)).id, { address: operation.alias });
        return `Removed ${operation.alias} from ${operation.address}`;
      case "setCatchAll":
        await this.setCatchAll(serverId, (await domainByName(operation.domain)).id, { address: operation.address });
        return operation.address ? `Catch-all of ${operation.domain} is ${operation.address}` : `Catch-all of ${operation.domain} is off`;
      case "createMailingList": {
        const { localPart, domain } = splitAddress(operation.address);
        await client.createMailingList({ domainId: (await domainByName(domain)).id, localPart, description: operation.description, recipients: operation.recipients });
        return `Created ${operation.address}`;
      }
      case "deleteMailingList":
        await client.deleteMailingList((await listByAddress(operation.address)).id);
        return `Deleted ${operation.address}`;
      case "generateDkim":
        await client.generateDkimKey((await domainByName(operation.domain)).id, operation.algorithm, operation.selector);
        return `Generated DKIM key ${operation.selector} for ${operation.domain}`;
      case "deleteDkim": {
        const domain = await domainByName(operation.domain);
        const key = (await client.dkimKeys(domain.id)).find(({ selector }) => selector === operation.selector);
        if (!key) throw new MailServerError(`${operation.domain} has no DKIM key ${operation.selector}`, 404);
        await client.deleteDkimKeys([key.id]);
        return `Deleted DKIM key ${operation.selector}`;
      }
      case "updateSpamSettings":
        await client.updateSpamSettings(operation.settings);
        return "Updated spam settings";
      case "retryQueuedMessage":
        await client.retryQueuedMessage(operation.id);
        return `Retrying ${operation.id}`;
      case "cancelQueuedMessage":
        await client.cancelQueuedMessage(operation.id);
        return `Cancelled ${operation.id}`;
    }
  }

  // Helpers

  async #addToPostreeve(serverId: string, client: StalwartClient, mailbox: StalwartMailbox): Promise<PostreeveAccountLink> {
    const server = this.#server(serverId);
    const appPassword = await client.createAppPassword(mailbox.id, APP_PASSWORD_NAME);
    try {
      const account = await this.#accounts.createAccount({
        kind: "imap", name: mailbox.displayName || mailbox.address, email: mailbox.address,
        host: server.mailHostname, port: IMAP_PORT, secure: true, username: mailbox.address, password: appPassword.secret,
        smtpHost: server.mailHostname, smtpPort: SMTP_PORT, smtpSecure: true, smtpUsername: mailbox.address, smtpPassword: appPassword.secret,
      });
      return { status: "added", accountId: account.id, reason: null };
    } catch (error) {
      // Leave no unused credential behind on the server.
      await client.revokeAppPassword(mailbox.id, appPassword.id).catch(() => undefined);
      return { status: "failed", accountId: null, reason: message(error) };
    }
  }

  async #registerIdentity(targetAddress: string, identityAddress: string, displayName: string | null): Promise<IdentityRegistration | null> {
    const account = (await this.#accounts.listAccounts()).find(({ email }) => email.toLowerCase() === targetAddress.toLowerCase());
    if (!account) return null;
    const parsed = createIdentityInputSchema.safeParse({ name: displayName || account.name, address: identityAddress });
    if (!parsed.success) {
      return { address: identityAddress, accountId: account.id, status: "skipped", reason: "Postreeve identities do not accept this address form yet" };
    }
    if ((await this.#accounts.listIdentities(account.id)).some(({ address }) => address === parsed.data.address)) {
      return { address: identityAddress, accountId: account.id, status: "existing", reason: null };
    }
    try {
      await this.#accounts.addIdentity(account.id, parsed.data);
      return { address: identityAddress, accountId: account.id, status: "registered", reason: null };
    } catch (error) {
      return { address: identityAddress, accountId: account.id, status: "skipped", reason: message(error) };
    }
  }

  async #knownAddresses(client: StalwartClient): Promise<Set<string>> {
    const [mailboxes, lists] = await Promise.all([client.mailboxes(), client.mailingLists()]);
    return new Set([
      ...mailboxes.flatMap((mailbox) => [mailbox.address, ...mailbox.aliases.map(({ address }) => address)]),
      ...lists.map(({ address }) => address),
    ].map((address) => address.toLowerCase()));
  }

  #public(mailbox: StalwartMailbox, accounts: readonly Account[]): Mailbox {
    const { localPart: _localPart, aliasObjects: _aliasObjects, passwordCredentialKey: _key, ...rest } = mailbox;
    const account = accounts.find(({ email }) => email.toLowerCase() === mailbox.address.toLowerCase());
    return { ...rest, postreeveAccountId: account?.id ?? null };
  }

  async #verify(connection: { name: string; baseUrl: string; credential: MailServerCredential }): Promise<{ publicHost: string | null }> {
    const jmap = new StalwartJmap(connection, this.#fetch);
    const { publicHost } = await jmap.session();
    await jmap.query("Domain", {}, 1);
    return { publicHost };
  }

  #server(id: string): StoredMailServer {
    const server = this.#store.getServer(id);
    if (!server) throw new MailServerError("Mail server not found", 404);
    return server;
  }

  #proposal(id: string): MailServerProposal {
    const proposal = this.#store.getProposal(id);
    if (!proposal) throw new MailServerError("Proposal not found", 404);
    return proposal;
  }

  #client(server: StoredMailServer): StalwartClient {
    const credential = mailServerCredentialSchema.parse(JSON.parse(this.#vault.decryptSecret(server.encryptedCredential)));
    return new StalwartClient(new StalwartJmap({ name: server.name, baseUrl: server.baseUrl, credential }, this.#fetch));
  }

  #clientFor(serverId: string): StalwartClient {
    return this.#client(this.#server(serverId));
  }
}

const notRequested: PostreeveAccountLink = { status: "not_requested", accountId: null, reason: null };

function publicServer(server: StoredMailServer): MailServer {
  const { encryptedCredential: _secret, ...rest } = server;
  return rest;
}
