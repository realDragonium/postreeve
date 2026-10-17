import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";
import type { Account, CreateAccountInput, Identity } from "../src/shared/contracts";
import { Store } from "../src/server/db/store";
import { CredentialVault } from "../src/server/security/credentials";
import { MailServerAdmin } from "../src/server/stalwart/service";

// Opt-in: runs only against a throwaway Stalwart started by `bun scripts/stalwart-test-instance.ts`.
// Never point these variables at a real mail server.
const url = process.env.POSTREEVE_STALWART_TEST_URL;
const apiKey = process.env.POSTREEVE_STALWART_TEST_KEY;
const imapPort = Number(process.env.POSTREEVE_STALWART_TEST_IMAP_PORT ?? 993);
const live = Boolean(url && apiKey);

async function imapLogin(user: string, pass: string): Promise<boolean> {
  const client = new ImapFlow({ host: "localhost", port: imapPort, secure: true, auth: { user, pass }, logger: false, tls: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!live)("live Stalwart v0.16 (throwaway instance)", () => {
  test("runs the whole admin workflow against a real server", async () => {
    const store = new Store(":memory:");
    const accounts: (Account & { input: CreateAccountInput })[] = [];
    const identities: Identity[] = [];
    const admin = new MailServerAdmin({
      store: store.mailServers,
      vault: new CredentialVault(randomBytes(32).toString("base64")),
      dns: { label: "none", lookup: async () => [] },
      accounts: {
        listAccounts: async () => accounts,
        // Stands in for Postreeve's own account check: the stored password must log in to IMAP.
        createAccount: async (input) => {
          if (!await imapLogin(input.username, input.password)) throw new Error("IMAP login failed");
          const account = { id: crypto.randomUUID(), name: input.name, email: input.email, kind: "imap" as const, input };
          accounts.push(account);
          return account;
        },
        listIdentities: async (accountId) => identities.filter((identity) => identity.accountId === accountId),
        addIdentity: async (accountId, input) => {
          const identity = { id: crypto.randomUUID(), accountId, ...input, createdAt: new Date().toISOString() };
          identities.push(identity);
          return { identity, created: true };
        },
      },
    });
    const suffix = randomBytes(3).toString("hex");
    const domainName = `live-${suffix}.example.com`;
    const server = await admin.connect({ name: "Throwaway", baseUrl: url!, mailHostname: "localhost", credential: { kind: "apiKey", apiKey: apiKey! } });

    const domain = await admin.addDomain(server.id, domainName);
    expect(domain.dkimManagement).toBe("automatic");
    await Bun.sleep(1500);
    expect((await admin.dkimKeys(server.id, domain.id)).length).toBeGreaterThanOrEqual(2);
    await admin.generateDkimKey(server.id, domain.id, { algorithm: "ed25519", selector: "live" });

    const { mailbox, account } = await admin.createMailbox(server.id, {
      domainId: domain.id, localPart: "alice", displayName: "Alice", password: "Live-Test-Password-1", quotaBytes: 1073741824, addToPostreeve: true,
    });
    expect(account.status).toBe("added");
    const appPassword = accounts[0]!.input.password;
    expect(appPassword).not.toBe("Live-Test-Password-1");

    await admin.resetPassword(server.id, mailbox.id, { password: "Live-Test-Password-2" });
    expect(await imapLogin(mailbox.address, "Live-Test-Password-2")).toBe(true);
    expect(await imapLogin(mailbox.address, appPassword)).toBe(true);

    const updated = await admin.updateMailbox(server.id, mailbox.id, { displayName: "Alice L", quotaBytes: null });
    expect(updated).toMatchObject({ displayName: "Alice L", quotaBytes: null });
    expect((await admin.addAlias(server.id, mailbox.id, { address: `info@${domainName}` })).identity?.status).toBe("registered");
    expect((await admin.setCatchAll(server.id, domain.id, { address: mailbox.address })).domain.catchAll).toBe(mailbox.address);
    const list = await admin.createMailingList(server.id, { domainId: domain.id, localPart: "team", recipients: [mailbox.address] });

    const checklist = await admin.dnsChecklist(server.id, domain.id);
    const categories = new Set(checklist.records.map(({ category }) => category));
    for (const category of ["mx", "spf", "dkim", "dmarc", "mta-sts", "tls-rpt", "autoconfig", "autodiscover"]) expect(categories).toContain(category as never);
    expect(checklist.records.find(({ name }) => name === `live._domainkey.${domainName}.`)).toBeDefined();

    const before = await admin.spamSettings(server.id);
    expect((await admin.updateSpamSettings(server.id, { spamThreshold: before.spamThreshold + 1 })).spamThreshold).toBe(before.spamThreshold + 1);
    await admin.updateSpamSettings(server.id, { spamThreshold: before.spamThreshold });
    const trusted = await admin.spamList(server.id, "trusted");
    expect(new Set(trusted.map(({ id }) => id)).size).toBe(trusted.length);
    const blocked = await admin.addSpamListEntry(server.id, "blocked", { domain: `spam-${suffix}.example.com` });
    await admin.removeSpamListEntry(server.id, "blocked", blocked.id);
    expect(Array.isArray(await admin.queue(server.id))).toBe(true);
    expect(Array.isArray(await admin.reports(server.id))).toBe(true);

    const proposal = admin.createProposal(server.id, { title: "Bob", operations: [{ type: "createMailbox", address: `bob@${domainName}`, displayName: "Bob" }] }, "live test");
    expect((await admin.approveProposal(proposal.id, { passwords: { 0: "Live-Test-Password-3" } })).status).toBe("applied");

    await expect(admin.deleteDomain(server.id, domain.id, { confirm: domainName })).rejects.toThrow("still use");
    await admin.deleteMailingList(server.id, list.id);
    await admin.setCatchAll(server.id, domain.id, { address: null });
    for (const box of await admin.mailboxes(server.id, domain.id)) await admin.deleteMailbox(server.id, box.id, { confirm: box.address });
    await admin.deleteDomain(server.id, domain.id, { confirm: domainName });
    expect((await admin.domains(server.id)).map(({ name }) => name)).not.toContain(domainName);
    store.close();
  }, 60_000);
});
