import { afterEach, describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import { createApi, type AppType } from "../src/server/api";
import { PostreeveService } from "../src/server/core/postreeve";
import { Store } from "../src/server/db/store";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
import { MailProviderRegistry, type ProviderMessageSummary } from "../src/server/mail/provider";
import { MailSenderRegistry } from "../src/server/mail/sender";
import { CredentialVault } from "../src/server/security/credentials";
import { identityImportResultSchema, type Account, type Identity } from "../src/shared/contracts";
import { defaultFromAddress, identityFor, signatureHtmlFor } from "../src/shared/identities";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

const account: Account = { id: "a", name: "Owner", email: "owner@primary.test", kind: "imap" };
const identity = (address: string, name = "Shop"): Identity =>
  ({ id: address, accountId: account.id, name, address, createdAt: "2026-10-17T00:00:00.000Z" });
const to = (address: string) => ({ name: "", address });

describe("wildcard identity resolution", () => {
  const identities = [identity("*@example.com"), identity("sales@example.com", "Sales")];

  test("covers exactly its domain and prefers an exact identity's name", () => {
    expect(identityFor("Orders@Example.com", account, identities)).toEqual({ name: "Shop", address: "orders@example.com" });
    expect(identityFor("sales@example.com", account, identities)).toEqual({ name: "Sales", address: "sales@example.com" });
    expect(identityFor("a@mail.example.com", account, identities)).toBeNull();
    expect(identityFor("a@other.test", account, identities)).toBeNull();
    expect(identityFor("*@example.com", account, identities)).toBeNull();
  });

  test("a reply defaults to the exact delivered address the wildcard covers", () => {
    expect(defaultFromAddress({ deliveredTo: ["newsletter-x@example.com"], to: [to("owner@primary.test")] }, account, identities))
      .toBe("newsletter-x@example.com");
    expect(defaultFromAddress({ to: [to("someone@other.test")], cc: [to("promo@example.com")] }, account, identities))
      .toBe("promo@example.com");
    expect(defaultFromAddress({ deliveredTo: ["x@other.test"], to: [to("x@other.test")] }, account, identities))
      .toBe("owner@primary.test");
  });

  test("a covered address uses its own signature, else the wildcard's", () => {
    const signatures = [{ address: "*@example.com", html: "<b>Shop</b>" }, { address: "sales@example.com", html: "<b>Sales</b>" }];
    expect(signatureHtmlFor("orders@example.com", signatures)).toBe("<b>Shop</b>");
    expect(signatureHtmlFor("Sales@example.com", signatures)).toBe("<b>Sales</b>");
    expect(signatureHtmlFor("a@other.test", signatures)).toBe("");
  });
});

function draftFrom(accountId: string, address: string) {
  return {
    accountId, mode: "new" as const, format: "plain" as const, to: "alice@example.test", cc: "", bcc: "",
    subject: "Hello", body: "Hi Alice", identity: { name: "", address }, attachments: [],
  };
}

describe("wildcard identities on IMAP accounts", () => {
  test("send from covered addresses and refuse undeclared domains and subdomains", async () => {
    const { service, store, sent, sendAttempts } = await createEmptyTestHarness();
    close.push(() => store.close());
    const created = await service.createAccount(testAccountInput());
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const added = await client.api.accounts[":accountId"].identities.$post({
      param: { accountId: created.id }, json: { name: "Shop", address: "*@Example.com" },
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ address: "*@example.com" });
    for (const address of ["*@*", "*@localhost", "a*@example.com"]) {
      const refused = await client.api.accounts[":accountId"].identities.$post({ param: { accountId: created.id }, json: { name: "X", address } });
      expect(refused.status).toBe(400);
    }

    const covered = await service.createDraft(draftFrom(created.id, "orders@example.com"));
    await service.sendDraft(created.id, covered.id, { version: covered.version });
    expect(sent[0]?.from).toEqual({ name: "Shop", address: "orders@example.com" });

    for (const address of ["orders@other.test", "a@mail.example.com"]) {
      const draft = await service.createDraft(draftFrom(created.id, address));
      await expect(service.sendDraft(created.id, draft.id, { version: draft.version }))
        .rejects.toThrow("Draft identity does not belong to the selected account");
    }
    expect(sendAttempts).toHaveLength(1);

    await expect(service.putSignature(created.id, { address: "*@example.com", html: "<b>Shop</b>" }))
      .resolves.toEqual({ address: "*@example.com", html: "<b>Shop</b>" });
    await expect(service.putSignature(created.id, { address: "*@other.test", html: "x" }))
      .rejects.toThrow("Signatures can only be set for the account's own addresses");
  });

  test("recipient suggestions treat covered addresses as own", async () => {
    const store = new Store(":memory:");
    close.push(() => store.close());
    await store.insertAccount({ id: "a", kind: "imap", name: "a", email: "a@me.test", encryptedCredentials: null });
    store.synchronization.schedule("t", "a", 0);
    const mail = (uid: number, from: string, recipient: string): ProviderMessageSummary => ({
      ref: { accountId: "a", mailbox: "INBOX", uidValidity: "1", uid, modseq: "1" }, messageId: `<${uid}@wildcard.test>`,
      subject: "Hi", from: [to(from)], to: [to(recipient)], receivedAt: "2026-05-01T00:00:00.000Z", preview: "", read: false, flagged: false,
    });
    store.synchronization.observe({ tenantId: "t", accountId: "a", provider: "imap" },
      [mail(1, "shop@example.com", "carol@x.test"), mail(2, "dave@x.test", "promo@example.com")], 1000);
    const suggest = (q: string) => store.recipientSuggestions("t", { q, limit: 8 }, new Date("2026-06-01T00:00:00.000Z"))
      .map(({ address }) => address);
    expect(suggest("example.com")).toEqual(["shop@example.com"]);

    await store.addIdentity("t", { ...identity("*@example.com"), accountId: "a" }, 10);
    expect(suggest("example.com")).toEqual([]);
    expect(suggest("x.test")).toEqual(["carol@x.test", "dave@x.test"]);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function gmailService(sendAs: unknown[]) {
  const request: HttpFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture", expires_in: 3600 });
    if (url.pathname.endsWith("/profile")) return json({ emailAddress: "person@gmail.test" });
    if (url.pathname.endsWith("/settings/sendAs")) return json({ sendAs });
    return new Response("{}", { status: 404 });
  };
  const store = new Store(":memory:");
  close.push(() => store.close());
  const unavailable = () => { throw new Error("IMAP is not used by this fixture"); };
  const service = new PostreeveService(store, { tenantId: "t" }, new MailProviderRegistry(), new MailSenderRegistry(),
    new CredentialVault(Buffer.alloc(32, 7).toString("base64")), unavailable, unavailable, (gmail, credentials) => {
      const client = new GmailMailClient({ account: gmail, credentials, clientId: "client", fetch: request });
      return { provider: client, sender: client };
    });
  return { store, service };
}

describe("Gmail Send mail as import", () => {
  const sendAs = [
    { sendAsEmail: "person@gmail.test", isPrimary: true },
    { sendAsEmail: "Team@Example.com", displayName: "Team", verificationStatus: "accepted" },
    { sendAsEmail: "domain-alias@example.com" },
    { sendAsEmail: "new@example.com", displayName: "New", verificationStatus: "pending" },
  ];

  test("connecting imports verified aliases once and refreshing is idempotent", async () => {
    const { service } = await gmailService(sendAs);
    const gmail = await service.connectGmailAccount("person@gmail.test", "refresh-token");
    expect((await service.listIdentities(gmail.id)).map(({ name, address }) => [name, address]))
      .toEqual([["Team", "team@example.com"], ["Gmail", "domain-alias@example.com"]]);

    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const refreshed = await client.api.accounts[":accountId"].identities.import.$post({ param: { accountId: gmail.id } });
    expect(refreshed.status).toBe(200);
    const result = identityImportResultSchema.parse(await refreshed.json());
    expect(result.imported).toBe(0);
    expect(result.identities).toHaveLength(2);
  });

  test("keeps renamed identities and refuses wildcards on Gmail", async () => {
    const { service } = await gmailService([]);
    const gmail = await service.connectGmailAccount("person@gmail.test", "refresh-token");
    await expect(service.addIdentity(gmail.id, { name: "Any", address: "*@example.com" }))
      .rejects.toThrow("Gmail sends only from verified addresses, so wildcard identities are IMAP-only");
    await expect(service.putFolderMappings(gmail.id, { sent: "SENT" })).rejects.toThrow("Gmail folders are fixed system labels");
  });

  test("import is refused for IMAP accounts", async () => {
    const { service, store } = await createEmptyTestHarness();
    close.push(() => store.close());
    const created = await service.createAccount(testAccountInput());
    await expect(service.importSendAsIdentities(created.id)).rejects.toThrow("Only Gmail accounts have Send mail as addresses");
  });

  test("a failing Send mail as list does not fail the connection", async () => {
    const request: HttpFetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture", expires_in: 3600 });
      if (url.pathname.endsWith("/profile")) return json({ emailAddress: "person@gmail.test" });
      return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
    };
    const store = new Store(":memory:");
    close.push(() => store.close());
    const unavailable = () => { throw new Error("IMAP is not used by this fixture"); };
    const service = new PostreeveService(store, { tenantId: "t" }, new MailProviderRegistry(), new MailSenderRegistry(),
      new CredentialVault(Buffer.alloc(32, 7).toString("base64")), unavailable, unavailable, (gmail, credentials) => {
        const client = new GmailMailClient({ account: gmail, credentials, clientId: "client", fetch: request });
        return { provider: client, sender: client };
      });
    const gmail = await service.connectGmailAccount("person@gmail.test", "refresh-token");
    expect(await service.listIdentities(gmail.id)).toEqual([]);
  });
});
