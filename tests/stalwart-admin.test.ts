import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Account, CreateAccountInput, Identity } from "../src/shared/contracts";
import { Store } from "../src/server/db/store";
import { CredentialVault } from "../src/server/security/credentials";
import { mailServerTools } from "../src/server/stalwart/agent-tools";
import type { DnsLookup } from "../src/server/stalwart/dns";
import { createMailServerRoutes } from "../src/server/stalwart/routes";
import { isPrivateHost, MailServerAdmin, normalizeAdminUrl } from "../src/server/stalwart/service";
import { FakeStalwart } from "./support/fake-stalwart";

const ADMIN_URL = "https://mail-admin.example.ts.net";

function harness(options: { fake?: FakeStalwart; failAccounts?: boolean; dns?: DnsLookup } = {}) {
  const fake = options.fake ?? new FakeStalwart();
  const store = new Store(":memory:");
  const accounts: (Account & { input: CreateAccountInput })[] = [];
  const identities: Identity[] = [];
  const admin = new MailServerAdmin({
    store: store.mailServers,
    vault: new CredentialVault(randomBytes(32).toString("base64")),
    fetch: fake.fetch,
    dns: options.dns ?? { label: "test DNS", lookup: async () => [] },
    accounts: {
      listAccounts: async () => accounts,
      createAccount: async (input) => {
        if (options.failAccounts) throw new Error("IMAP login failed");
        const account = { id: crypto.randomUUID(), name: input.name, email: input.email, kind: "imap" as const, input };
        accounts.push(account);
        return account;
      },
      listIdentities: async (accountId) => identities.filter((identity) => identity.accountId === accountId),
      addIdentity: async (accountId, input) => {
        const identity = { id: crypto.randomUUID(), accountId, name: input.name, address: input.address, createdAt: new Date().toISOString() };
        identities.push(identity);
        return { identity, created: true };
      },
    },
  });
  const connect = () => admin.connect({ name: "Contabo", baseUrl: ADMIN_URL, credential: { kind: "apiKey", apiKey: fake.apiKey } });
  return { fake, store, admin, accounts, identities, connect };
}

async function withDomain(name = "example.org") {
  const context = harness();
  const server = await context.connect();
  const domain = await context.admin.addDomain(server.id, name);
  return { ...context, server, domain };
}

describe("connecting a Stalwart server", () => {
  test("saves a working server, reports its domains and never returns the key", async () => {
    const { admin, fake, store, connect } = harness();
    fake.addDomain("example.org");
    const server = await connect();
    expect(server).toMatchObject({ name: "Contabo", baseUrl: ADMIN_URL, credentialKind: "apiKey", mailHostname: "mail.example.org" });
    const listed = await admin.listServers();
    expect(listed).toEqual([expect.objectContaining({ id: server.id, domainCount: 1, error: null })]);
    expect(JSON.stringify([server, listed])).not.toContain(fake.apiKey);
    expect(store.mailServers.getServer(server.id)!.encryptedCredential).not.toContain(fake.apiKey);
    expect(fake.authorizations.every((value) => value === `Bearer ${fake.apiKey}`)).toBe(true);
    store.close();
  });

  test("accepts admin username and password as Basic auth", async () => {
    const { admin } = harness();
    const server = await admin.connect({ name: "Basic", baseUrl: ADMIN_URL, credential: { kind: "basic", username: "admin@example.org", password: "admin-password" } });
    expect(server.credentialKind).toBe("basic");
  });

  test("needs a hostname, not an IP address, for IMAP and SMTP", async () => {
    const { admin, fake } = harness();
    await expect(admin.connect({ name: "IP", baseUrl: ADMIN_URL, mailHostname: "203.0.113.5", credential: { kind: "apiKey", apiKey: fake.apiKey } }))
      .rejects.toThrow("not an IP address");
  });

  test("rejects a wrong credential and stores nothing", async () => {
    const { admin, store } = harness();
    await expect(admin.connect({ name: "Bad", baseUrl: ADMIN_URL, credential: { kind: "apiKey", apiKey: "wrong" } }))
      .rejects.toThrow("Stalwart rejected the admin credential");
    expect(store.mailServers.listServers()).toEqual([]);
  });

  test("refuses plain HTTP to a public host before connecting", async () => {
    const { admin, fake } = harness();
    await expect(admin.connect({ name: "Plain", baseUrl: "http://mail.example.com", credential: { kind: "apiKey", apiKey: fake.apiKey } }))
      .rejects.toThrow("must use HTTPS");
    expect(fake.authorizations).toEqual([]);
  });

  test("allows HTTP only on loopback, private and tailnet addresses", () => {
    for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.2", "172.20.0.3", "100.101.102.103", "vps.tail1234.ts.net", "stalwart", "[::1]"]) {
      expect(isPrivateHost(host)).toBe(true);
    }
    for (const host of ["mail.example.com", "8.8.8.8", "100.128.0.1", "172.32.0.1"]) expect(isPrivateHost(host)).toBe(false);
    expect(normalizeAdminUrl("http://100.64.0.7:8080/")).toBe("http://100.64.0.7:8080");
    expect(normalizeAdminUrl("https://mail.example.com/admin/")).toBe("https://mail.example.com/admin");
    expect(() => normalizeAdminUrl("https://admin:secret@mail.example.com")).toThrow("own field");
  });

  test("names Stalwart v0.16 when the management capability is missing", async () => {
    const fake = new FakeStalwart({ capability: false });
    const { connect } = harness({ fake });
    await expect(connect()).rejects.toThrow("Stalwart v0.16 or later");
  });

  test("reports an unreachable server by name", async () => {
    const { admin } = harness();
    const unreachable = new MailServerAdmin({
      store: new Store(":memory:").mailServers, vault: new CredentialVault(randomBytes(32).toString("base64")),
      accounts: { listAccounts: async () => [], createAccount: async () => { throw new Error(); }, listIdentities: async () => [], addIdentity: async () => { throw new Error(); } },
      dns: { label: "", lookup: async () => [] },
      fetch: async () => { throw new TypeError("fetch failed"); },
    });
    await expect(unreachable.connect({ name: "Contabo", baseUrl: ADMIN_URL, credential: { kind: "apiKey", apiKey: "x" } }))
      .rejects.toThrow("Mail server is unreachable: Contabo");
    expect(admin).toBeDefined();
  });

  test("disconnecting removes the record and its proposals but changes nothing on Stalwart", async () => {
    const { admin, fake, server } = await withDomain();
    admin.createProposal(server.id, { title: "Add", operations: [{ type: "addDomain", domain: "example.net" }] }, "agent");
    admin.disconnect(server.id);
    expect(await admin.listServers()).toEqual([]);
    expect(admin.listProposals()).toEqual([]);
    expect(fake.list("Domain").map(({ name }) => name)).toEqual(["example.org"]);
  });
});

describe("domains", () => {
  test("a new domain uses automatic DKIM, so Stalwart generates its keys", async () => {
    const { admin, server, domain } = await withDomain("example.net");
    expect(domain).toMatchObject({ name: "example.net", dkimManagement: "automatic", catchAll: null });
    expect((await admin.dkimKeys(server.id, domain.id)).map(({ algorithm }) => algorithm).sort()).toEqual(["Dkim1Ed25519Sha256", "Dkim1RsaSha256"]);
  });

  test("a duplicate domain fails with Stalwart's reason", async () => {
    const { admin, server } = await withDomain();
    await expect(admin.addDomain(server.id, "example.org")).rejects.toThrow("already exists");
  });

  test("deleting needs the name typed again", async () => {
    const { admin, fake, server, domain } = await withDomain("example.net");
    await expect(admin.deleteDomain(server.id, domain.id, { confirm: "example.ne" })).rejects.toThrow("Type example.net");
    await expect(admin.deleteDomain(server.id, domain.id, {})).rejects.toThrow();
    expect(fake.list("Domain")).toHaveLength(1);
  });

  test("deleting refuses while mailboxes use the domain", async () => {
    const { admin, fake, server, domain } = await withDomain("example.net");
    fake.addMailbox("alice", domain.id);
    fake.addMailbox("bob", domain.id);
    await expect(admin.deleteDomain(server.id, domain.id, { confirm: "example.net" })).rejects.toThrow("2 mailboxes still use example.net");
  });

  test("deleting an empty domain removes its DKIM keys and the domain", async () => {
    const { admin, fake, server, domain } = await withDomain("example.net");
    await admin.deleteDomain(server.id, domain.id, { confirm: "example.net" });
    expect(fake.list("Domain")).toEqual([]);
    expect(fake.list("DkimSignature")).toEqual([]);
  });
});

describe("mailboxes", () => {
  test("creates a mailbox with display name and quota, and keeps no password", async () => {
    const { admin, fake, store, server, domain } = await withDomain();
    const { mailbox, account } = await admin.createMailbox(server.id, {
      domainId: domain.id, localPart: "alice", displayName: "Alice", password: "Correct-Horse-9", quotaBytes: 1073741824,
    });
    expect(mailbox).toMatchObject({ address: "alice@example.org", displayName: "Alice", quotaBytes: 1073741824, postreeveAccountId: null });
    expect(account.status).toBe("not_requested");
    expect(fake.find("Account", ({ name }) => name === "alice")).toMatchObject({ description: "Alice", quotas: { maxDiskQuota: 1073741824 } });
    expect(JSON.stringify(store.mailServers.listServers())).not.toContain("Correct-Horse-9");
  });

  test("a weak password fails with Stalwart's reason and creates nothing", async () => {
    const { admin, fake, server, domain } = await withDomain();
    await expect(admin.createMailbox(server.id, { domainId: domain.id, localPart: "weak", password: "password123" })).rejects.toThrow("Password is too weak");
    expect(fake.list("Account")).toEqual([]);
  });

  test("changes display name and quota, and resets the password without touching app passwords", async () => {
    const { admin, fake, server, domain } = await withDomain();
    const id = fake.addMailbox("alice", domain.id);
    await admin.addMailboxToPostreeve(server.id, id);
    const updated = await admin.updateMailbox(server.id, id, { displayName: "Alice A", quotaBytes: 5_000_000 });
    expect(updated).toMatchObject({ displayName: "Alice A", quotaBytes: 5_000_000 });
    expect((await admin.updateMailbox(server.id, id, { quotaBytes: null })).quotaBytes).toBeNull();
    await admin.resetPassword(server.id, id, { password: "Brand-New-Secret-1" });
    const credentials = fake.objects.get("Account")!.get(id)!.credentials as Record<string, { secret: string }>;
    expect(credentials["0"]!.secret).toBe("Brand-New-Secret-1");
    expect(fake.appPasswords.get(id)!.size).toBe(1);
    await expect(admin.resetPassword(server.id, id, { password: "short" })).rejects.toThrow();
  });

  test("deleting needs the full address typed again", async () => {
    const { admin, fake, server, domain } = await withDomain();
    const id = fake.addMailbox("alice", domain.id);
    await expect(admin.deleteMailbox(server.id, id, {})).rejects.toThrow();
    await expect(admin.deleteMailbox(server.id, id, { confirm: "alice" })).rejects.toThrow("Type alice@example.org");
    await admin.deleteMailbox(server.id, id, { confirm: "Alice@Example.org" });
    expect(fake.list("Account")).toEqual([]);
  });
});

describe("one-step Postreeve account", () => {
  test("creates an app password and adds an IMAP account that stores only it", async () => {
    const { admin, fake, accounts, server, domain } = await withDomain();
    const { mailbox, account } = await admin.createMailbox(server.id, {
      domainId: domain.id, localPart: "bob", displayName: "Bob", password: "Bobs-Own-Secret-7", addToPostreeve: true,
    });
    expect(account).toMatchObject({ status: "added", reason: null });
    expect(mailbox.postreeveAccountId).toBe(account.accountId);
    const [appPassword] = [...fake.appPasswords.get(mailbox.id)!.values()];
    expect(appPassword).toMatchObject({ description: "Postreeve" });
    expect(accounts[0]!.input).toEqual({
      kind: "imap", name: "Bob", email: "bob@example.org",
      host: "mail.example.org", port: 993, secure: true, username: "bob@example.org", password: appPassword!.secret as string,
      smtpHost: "mail.example.org", smtpPort: 465, smtpSecure: true, smtpUsername: "bob@example.org", smtpPassword: appPassword!.secret as string,
    });
    expect(JSON.stringify(accounts[0]!.input)).not.toContain("Bobs-Own-Secret-7");
  });

  test("keeps the mailbox and revokes the app password when the account cannot connect", async () => {
    const fake = new FakeStalwart();
    const { admin, connect } = harness({ fake, failAccounts: true });
    const server = await connect();
    const domain = await admin.addDomain(server.id, "example.org");
    const { mailbox, account } = await admin.createMailbox(server.id, { domainId: domain.id, localPart: "bob", password: "Bobs-Own-Secret-7", addToPostreeve: true });
    expect(account).toEqual({ status: "failed", accountId: null, reason: "IMAP login failed" });
    expect(fake.find("Account", ({ name }) => name === "bob")).toBeDefined();
    expect(fake.appPasswords.get(mailbox.id)!.size).toBe(0);
  });
});

describe("aliases, catch-all and identities", () => {
  test("an alias on a Postreeve mailbox registers the identity", async () => {
    const { admin, fake, identities, server, domain } = await withDomain();
    const id = fake.addMailbox("alice", domain.id, { description: "Alice" });
    const { account } = await admin.addMailboxToPostreeve(server.id, id);
    const result = await admin.addAlias(server.id, id, { address: "Info@example.org" });
    expect(result.mailbox.aliases).toEqual([{ address: "info@example.org", enabled: true }]);
    expect(result.identity).toEqual({ address: "info@example.org", accountId: account.accountId, status: "registered", reason: null });
    expect(identities).toEqual([expect.objectContaining({ address: "info@example.org", name: "Alice" })]);
    expect((await admin.addAlias(server.id, id, { address: "sales@example.org" })).mailbox.aliases).toHaveLength(2);
    await expect(admin.addAlias(server.id, id, { address: "info@example.org" })).rejects.toThrow("already an address");
    expect((await admin.removeAlias(server.id, id, { address: "info@example.org" })).aliases).toEqual([{ address: "sales@example.org", enabled: true }]);
  });

  test("an alias on a mailbox outside Postreeve creates no identity", async () => {
    const { admin, fake, identities, server, domain } = await withDomain();
    const id = fake.addMailbox("alice", domain.id);
    expect((await admin.addAlias(server.id, id, { address: "info@example.org" })).identity).toBeNull();
    expect(identities).toEqual([]);
    await expect(admin.addAlias(server.id, id, { address: "info@elsewhere.example.com" })).rejects.toThrow("not a domain on this server");
  });

  test("a catch-all must point at an existing address and reports the wildcard identity as skipped", async () => {
    const { admin, fake, server, domain } = await withDomain();
    const id = fake.addMailbox("alice", domain.id);
    await expect(admin.setCatchAll(server.id, domain.id, { address: "nobody@example.org" })).rejects.toThrow("is not a mailbox");
    await admin.addMailboxToPostreeve(server.id, id);
    const result = await admin.setCatchAll(server.id, domain.id, { address: "alice@example.org" });
    expect(result.domain.catchAll).toBe("alice@example.org");
    expect(result.identity).toMatchObject({ address: "*@example.org", status: "skipped" });
    expect((await admin.setCatchAll(server.id, domain.id, { address: null })).domain.catchAll).toBeNull();
  });
});

describe("mailing lists, DKIM, queue, reports and spam", () => {
  test("creates, edits and deletes a mailing list", async () => {
    const { admin, fake, server, domain } = await withDomain();
    const list = await admin.createMailingList(server.id, { domainId: domain.id, localPart: "team", recipients: ["Alice@example.org", "bob@example.org"] });
    expect(list).toMatchObject({ address: "team@example.org", recipients: ["alice@example.org", "bob@example.org"] });
    expect((await admin.updateMailingList(server.id, list.id, { recipients: ["bob@example.org"] })).recipients).toEqual(["bob@example.org"]);
    await admin.deleteMailingList(server.id, list.id);
    expect(fake.list("MailingList")).toEqual([]);
  });

  test("generates DKIM keys without storing or returning the private key", async () => {
    const { admin, fake, store, server, domain } = await withDomain();
    for (const algorithm of ["rsa", "ed25519"] as const) {
      const key = await admin.generateDkimKey(server.id, domain.id, { algorithm, selector: `pr-${algorithm}` });
      expect(key).toMatchObject({ selector: `pr-${algorithm}`, algorithm: algorithm === "rsa" ? "Dkim1RsaSha256" : "Dkim1Ed25519Sha256", stage: "active" });
      expect(JSON.stringify(key)).not.toContain("PRIVATE KEY");
    }
    const sent = fake.requests.filter(({ method, args }) => method === "x:DkimSignature/set" && args.create);
    expect(JSON.stringify(sent)).toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(store.mailServers.listServers())).not.toContain("PRIVATE KEY");
    const zone = await admin.dnsChecklist(server.id, domain.id);
    expect(zone.records.filter(({ category }) => category === "dkim").map(({ name }) => name)).toContain("pr-rsa._domainkey.example.org.");
    const rsa = (await admin.dkimKeys(server.id, domain.id)).find(({ selector }) => selector === "pr-rsa")!;
    await admin.deleteDkimKey(server.id, rsa.id);
    expect((await admin.dkimKeys(server.id, domain.id)).map(({ selector }) => selector)).not.toContain("pr-rsa");
  });

  test("lists, retries and cancels queued messages", async () => {
    const { admin, fake, server } = await withDomain();
    fake.addQueuedMessage("q1", {
      returnPath: "alice@example.org", size: 2048, createdAt: "2026-10-17T10:00:00Z", nextRetry: "2026-10-17T12:30:00Z",
      recipients: {
        "friend@example.com": { retryCount: 3, retryDue: "2026-10-17T12:30:00Z", status: { "@type": "TemporaryFailure", errorType: "connectionError", errorMessage: "Connection timed out" } },
        "other@example.net": { retryCount: 1, status: { "@type": "PermanentFailure", responseCode: 550, responseEnhanced: "5.1.1", responseMessage: "No such user" } },
      },
    });
    const [message] = await admin.queue(server.id);
    expect(message).toEqual({
      id: "q1", from: "alice@example.org", size: 2048, createdAt: "2026-10-17T10:00:00Z", nextRetry: "2026-10-17T12:30:00Z",
      recipients: [
        { address: "friend@example.com", status: "temporaryFailure", retryCount: 3, retryDue: "2026-10-17T12:30:00Z", lastError: "Connection timed out" },
        { address: "other@example.net", status: "permanentFailure", retryCount: 1, retryDue: null, lastError: "550 5.1.1 No such user" },
      ],
    });
    await admin.retryQueuedMessage(server.id, "q1");
    expect(fake.objects.get("QueuedMessage")!.get("q1")!.nextRetry).toBe("2000-01-01T00:00:00Z");
    await admin.cancelQueuedMessage(server.id, "q1");
    expect(await admin.queue(server.id)).toEqual([]);
  });

  test("summarizes received DMARC and TLS reports, newest first", async () => {
    const { admin, fake, server } = await withDomain();
    fake.addReport("DmarcExternalReport", {
      from: "noreply-dmarc@google.example", subject: "Report domain: example.org", receivedAt: "2026-10-16T08:00:00Z",
      report: { orgName: "google.com", policyDomain: "example.org", dateRangeBegin: "2026-10-15T00:00:00Z", dateRangeEnd: "2026-10-16T00:00:00Z",
        records: { 0: { count: 8, evaluatedDkim: "pass", evaluatedSpf: "fail" }, 1: { count: 2, evaluatedDkim: "fail", evaluatedSpf: "fail" } } },
    });
    fake.addReport("TlsExternalReport", {
      from: "tlsrpt@microsoft.example", subject: "TLS report", receivedAt: "2026-10-17T08:00:00Z",
      report: { organizationName: "Microsoft", dateRangeStart: "2026-10-16T00:00:00Z", dateRangeEnd: "2026-10-17T00:00:00Z",
        policies: { 0: { policyDomain: "example.org", totalSuccessfulSessions: 40, totalFailedSessions: 1 } } },
    });
    const reports = await admin.reports(server.id);
    expect(reports.map(({ kind, reporter, pass, fail }) => ({ kind, reporter, pass, fail }))).toEqual([
      { kind: "tls", reporter: "Microsoft", pass: 40, fail: 1 },
      { kind: "dmarc", reporter: "google.com", pass: 8, fail: 2 },
    ]);
  });

  test("changes one spam threshold and manages trusted and blocked domains", async () => {
    const { admin, fake, server } = await withDomain();
    expect(await admin.updateSpamSettings(server.id, { spamThreshold: 6 })).toEqual({ enabled: true, spamThreshold: 6, rejectThreshold: 0, discardThreshold: 0 });
    expect(fake.objects.get("SpamSettings")!.get("singleton")).toMatchObject({ scoreSpam: 6, trustContacts: true, greylistFor: null });
    const entry = await admin.addSpamListEntry(server.id, "blocked", { domain: "Spam.Example.com" });
    expect(await admin.spamList(server.id, "blocked")).toEqual([{ id: entry.id, domain: "spam.example.com" }]);
    expect((await admin.spamList(server.id, "trusted")).map(({ domain }) => domain)).toEqual(["gmail.com", "outlook.com"]);
    await expect(admin.removeSpamListEntry(server.id, "trusted", entry.id)).rejects.toThrow("not found in that list");
    await admin.removeSpamListEntry(server.id, "blocked", entry.id);
    expect(await admin.spamList(server.id, "blocked")).toEqual([]);
  });

  test("returns every entry of a long list despite Stalwart's paging quirk", async () => {
    const { admin, fake, server } = await withDomain();
    for (let index = 0; index < 600; index += 1) await admin.addSpamListEntry(server.id, "trusted", { domain: `d${String(index).padStart(3, "0")}.example.com` });
    const entries = await admin.spamList(server.id, "trusted");
    expect(entries).toHaveLength(602);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(602);
    expect(fake.requests.filter(({ method, args }) => method === "x:MemoryLookupKey/get" && (args.ids as string[]).length > 500)).toEqual([]);
  });

  test("turns a Stalwart method error into a plain message", async () => {
    const { admin, fake, server } = await withDomain();
    fake.failNext.set("x:SpamSettings/get", { type: "forbidden", description: "You do not have permission" });
    await expect(admin.spamSettings(server.id)).rejects.toThrow("Contabo: You do not have permission");
  });
});

describe("mail server proposals", () => {
  test("an agent proposal changes nothing until the owner approves it with the passwords", async () => {
    const { admin, fake, accounts, server } = await withDomain();
    const proposal = admin.createProposal(server.id, {
      title: "Set up Carol",
      operations: [{ type: "addDomain", domain: "example.net" }, { type: "createMailbox", address: "carol@example.net", displayName: "Carol", addToPostreeve: true }],
    }, "Claude");
    expect(proposal).toMatchObject({ status: "pending", createdBy: "Claude" });
    expect(fake.list("Domain")).toHaveLength(1);
    await expect(admin.approveProposal(proposal.id, {})).rejects.toThrow("Set a password for carol@example.net");
    const applied = await admin.approveProposal(proposal.id, { passwords: { 1: "Carols-Secret-42" } });
    expect(applied.status).toBe("applied");
    expect(applied.results).toEqual([
      { index: 0, ok: true, message: "Added example.net" },
      { index: 1, ok: true, message: "Created carol@example.net and added it to Postreeve" },
    ]);
    expect(accounts.map(({ email }) => email)).toEqual(["carol@example.net"]);
    await expect(admin.approveProposal(proposal.id, { passwords: { 1: "Carols-Secret-42" } })).rejects.toThrow("Only a pending proposal");
  });

  test("an agent cannot supply a mailbox password", () => {
    const { admin } = harness();
    expect(() => admin.createProposal(crypto.randomUUID(), {
      title: "x", operations: [{ type: "createMailbox", address: "a@example.org", password: "Agent-Picked-1" } as never],
    }, "agent")).toThrow();
  });

  test("deletions need each name typed at approval, otherwise nothing applies", async () => {
    const { admin, fake, server, domain } = await withDomain();
    fake.addMailbox("old", domain.id);
    const proposal = admin.createProposal(server.id, { title: "Clean up", operations: [
      { type: "setCatchAll", domain: "example.org", address: null }, { type: "deleteMailbox", address: "old@example.org" },
    ] }, "agent");
    await expect(admin.approveProposal(proposal.id, { confirmations: ["old@example"] })).rejects.toThrow("Type old@example.org");
    expect(fake.list("Account")).toHaveLength(1);
    expect(admin.listProposals()[0]!.status).toBe("pending");
    expect((await admin.approveProposal(proposal.id, { confirmations: ["old@example.org"] })).status).toBe("applied");
    expect(fake.list("Account")).toEqual([]);
  });

  test("the first failing operation stops the rest", async () => {
    const { admin, fake, server } = await withDomain();
    const proposal = admin.createProposal(server.id, { title: "Two domains", operations: [
      { type: "addDomain", domain: "example.org" }, { type: "addDomain", domain: "example.net" },
    ] }, "agent");
    const result = await admin.approveProposal(proposal.id, {});
    expect(result.status).toBe("failed");
    expect(result.results).toEqual([{ index: 0, ok: false, message: expect.stringContaining("already exists") }]);
    expect(fake.list("Domain").map(({ name }) => name)).toEqual(["example.org"]);
  });

  test("the owner can reject a pending proposal", async () => {
    const { admin, server } = await withDomain();
    const proposal = admin.createProposal(server.id, { title: "No", operations: [{ type: "retryQueuedMessage", id: "q1" }] }, "agent");
    expect(admin.rejectProposal(proposal.id).status).toBe("rejected");
    expect(() => admin.rejectProposal(proposal.id)).toThrow("Only a pending proposal");
  });
});

describe("mail server routes", () => {
  test("serve the admin area without exposing secrets and keep typed confirmation", async () => {
    const { admin, fake } = harness();
    const app = createMailServerRoutes(admin);
    const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const connected = await app.request("/api/mail-servers", json({ name: "Contabo", baseUrl: ADMIN_URL, credential: { kind: "apiKey", apiKey: fake.apiKey } }));
    expect(connected.status).toBe(201);
    const { id } = await connected.json() as { id: string };
    const listed = await app.request("/api/mail-servers");
    expect(await listed.text()).not.toContain(fake.apiKey);
    const domain = await (await app.request(`/api/mail-servers/${id}/domains`, json({ name: "example.net" }))).json() as { id: string };
    const refused = await app.request(`/api/mail-servers/${id}/domains/${domain.id}`, { method: "DELETE" });
    expect(refused.status).toBe(400);
    const missing = await app.request(`/api/mail-servers/${crypto.randomUUID()}/domains`);
    expect(missing.status).toBe(404);
    const dns = await app.request(`/api/mail-servers/${id}/domains/${domain.id}/dns`);
    expect((await dns.json() as { records: unknown[] }).records.length).toBeGreaterThan(5);
    const deleted = await app.request(`/api/mail-servers/${id}/domains/${domain.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "example.net" }) });
    expect(deleted.status).toBe(200);
    const badKey = await app.request("/api/mail-servers", json({ name: "Bad", baseUrl: ADMIN_URL, credential: { kind: "apiKey", apiKey: "nope" } }));
    expect(badKey.status).toBe(400);
    expect(await badKey.json()).toEqual({ error: "Stalwart rejected the admin credential" });
  });
});

describe("mail server agent tools", () => {
  test("read tools return no secrets and no tool decides a proposal", async () => {
    const dns: DnsLookup = { label: "test DNS", lookup: async (name, type) => type === "MX" && name === "example.org." ? ["10 mail.example.org."] : [] };
    const { admin, fake, connect } = harness({ dns });
    const server = await connect();
    const domain = await admin.addDomain(server.id, "example.org");
    const mailbox = fake.addMailbox("alice", domain.id);
    await admin.addMailboxToPostreeve(server.id, mailbox);
    const tools = mailServerTools(admin, "Claude");
    expect(tools.map(({ name }) => name)).toEqual(["list_mail_servers", "list_mail_server_domains", "check_mail_server_dns", "inspect_mail_server_queue", "propose_mail_server_change"]);
    expect(tools.filter(({ annotations }) => annotations?.readOnlyHint).map(({ name }) => name)).toHaveLength(4);
    expect(tools.some(({ name }) => /approve|apply|reject/.test(name))).toBe(false);
    const run = (name: string, input: unknown) => tools.find((tool) => tool.name === name)!.execute(input, { signal: new AbortController().signal });

    const outputs = [
      await run("list_mail_servers", {}),
      await run("list_mail_server_domains", { serverId: server.id }),
      await run("check_mail_server_dns", { serverId: server.id, domain: "example.org" }),
      await run("inspect_mail_server_queue", { serverId: server.id }),
    ];
    expect(outputs[1]).toEqual([{ name: "example.org", enabled: true, catchAll: null, aliases: [], mailboxes: 1, mailingLists: 0 }]);
    expect((outputs[2] as { summary: { ok: number } }).summary.ok).toBe(1);
    const serialized = JSON.stringify(outputs);
    expect(serialized).not.toContain(fake.apiKey);
    expect(serialized).not.toContain("app_fake");
    await expect(run("list_mail_servers", { extra: true })).rejects.toThrow();

    const proposal = await run("propose_mail_server_change", { serverId: server.id, title: "Alias", operations: [{ type: "addAlias", address: "alice@example.org", alias: "info@example.org" }] });
    expect(proposal).toMatchObject({ status: "pending", createdBy: "Claude" });
    expect(fake.find("Account", ({ name }) => name === "alice")!.aliases).toEqual({});
  });
});
