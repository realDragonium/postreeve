import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Store } from "../src/server/db/store";
import { planChanges, txtKind } from "../src/server/dns-providers/plan";
import { createDnsProviderRoutes } from "../src/server/dns-providers/routes";
import { DnsProviders } from "../src/server/dns-providers/service";
import { recordKey, type ProviderRecord } from "../src/server/dns-providers/types";
import { CredentialVault } from "../src/server/security/credentials";
import { MailServerAdmin } from "../src/server/stalwart/service";
import { fakeDnsFetch, FakeCloudflare, FakeGoDaddy } from "./support/fake-dns-providers";
import { FakeStalwart } from "./support/fake-stalwart";

async function harness() {
  const stalwart = new FakeStalwart();
  const cloudflare = new FakeCloudflare();
  const godaddy = new FakeGoDaddy();
  const store = new Store(":memory:");
  const vault = new CredentialVault(randomBytes(32).toString("base64"));
  const admin = new MailServerAdmin({
    store: store.mailServers, vault, fetch: stalwart.fetch, dns: { label: "none", lookup: async () => [] },
    accounts: { listAccounts: async () => [], createAccount: async () => { throw new Error("unused"); }, listIdentities: async () => [], addIdentity: async () => { throw new Error("unused"); } },
  });
  const dns = new DnsProviders({ store: store.dnsProviders, vault, records: admin, fetch: fakeDnsFetch(cloudflare, godaddy) as typeof fetch });
  admin.setDnsApplier(async (serverId, domainId) => `Published ${(await dns.applyDefaults(serverId, domainId)).results.length} DNS changes`);
  const server = await admin.connect({ name: "Stalwart", baseUrl: "https://mail-admin.example.ts.net", credential: { kind: "apiKey", apiKey: stalwart.apiKey } });
  return { stalwart, cloudflare, godaddy, store, admin, dns, server };
}

const foreignRecords = [
  { type: "MX", name: "example.org", content: "old-mx.example.net", priority: 10 },
  { type: "TXT", name: "example.org", content: "\"v=spf1 include:old.example -all\"" },
  { type: "TXT", name: "example.org", content: "google-site-verification=abc" },
];

describe("DNS plan rules", () => {
  const record = (id: string, type: ProviderRecord["type"], name: string, value: string): ProviderRecord => ({ id, type, name, value });

  test("TXT records match by policy kind, never touching unrelated TXT", () => {
    expect(txtKind("v=spf1 mx -all")).toBe("v=spf1");
    expect(txtKind("V=DMARC1; p=reject")).toBe("v=dmarc1");
    expect(txtKind("google-site-verification=x")).toBeNull();
    const plan = planChanges(
      [{ type: "TXT", name: "example.org", value: "v=spf1 mx -all" }],
      [record("a", "TXT", "example.org", "google-site-verification=x"), record("b", "TXT", "example.org", "v=spf1 a -all"), record("c", "TXT", "example.org", "v=spf1 ip4:1.2.3.4 -all")],
      new Set(),
    );
    expect(plan.changes.map(({ action, from, selected }) => ({ action, from, selected }))).toEqual([
      { action: "update", from: "v=spf1 a -all", selected: false },
      { action: "delete", from: "v=spf1 ip4:1.2.3.4 -all", selected: false },
    ]);
  });

  test("changes to records Postreeve created are selected; stale ones are deleted", () => {
    const old = record("d", "TXT", "_dmarc.example.org", "v=DMARC1; p=none");
    const stale = record("k", "TXT", "old._domainkey.example.org", "v=DKIM1; p=OLD");
    const plan = planChanges([{ type: "TXT", name: "_dmarc.example.org", value: "v=DMARC1; p=reject" }], [old, stale], new Set([recordKey(old), recordKey(stale)]));
    expect(plan.changes.map(({ action, name, selected, owned }) => ({ action, name, selected, owned }))).toEqual([
      { action: "update", name: "_dmarc.example.org", selected: true, owned: true },
      { action: "delete", name: "old._domainkey.example.org", selected: true, owned: true },
    ]);
  });

  test("an identical record is in sync and hosts compare without trailing dot or case", () => {
    const plan = planChanges([{ type: "MX", name: "example.org", value: "10 mail.example.org" }], [record("m", "MX", "example.org", "10 MAIL.example.org.")], new Set());
    expect(plan).toMatchObject({ inSync: 1, changes: [] });
  });
});

describe("Cloudflare", () => {
  test("connects with a token, never returns it and refuses a bad one", async () => {
    const { dns, cloudflare, store } = await harness();
    cloudflare.addZone("example.org");
    cloudflare.addZone("example.net");
    await expect(dns.connect({ name: "CF", credential: { kind: "cloudflare", apiToken: "wrong" } })).rejects.toThrow("Cloudflare rejected the API token: Invalid API Token");
    expect(store.dnsProviders.list()).toEqual([]);
    const provider = await dns.connect({ name: "CF", credential: { kind: "cloudflare", apiToken: cloudflare.token } });
    const listed = await dns.list();
    expect(listed).toEqual([expect.objectContaining({ id: provider.id, kind: "cloudflare", zones: ["example.net", "example.org"], error: null })]);
    expect(JSON.stringify([provider, listed])).not.toContain(cloudflare.token);
    expect(store.dnsProviders.get(provider.id)!.encryptedCredential).not.toContain(cloudflare.token);
  });

  test("plans, applies the confirmed selection and leaves foreign records alone", async () => {
    const { dns, cloudflare, stalwart, admin, server } = await harness();
    const domain = await admin.addDomain(server.id, "example.org");
    cloudflare.addZone("example.org", foreignRecords);
    await dns.connect({ name: "CF", credential: { kind: "cloudflare", apiToken: cloudflare.token } });
    const plan = await dns.plan(server.id, domain.id);
    expect(plan).toMatchObject({ status: "ready", zone: "example.org", providerName: "CF", inSync: 0 });
    const summary = plan.changes.map(({ action, type, name, selected }) => `${action} ${type} ${name} ${selected ? "on" : "off"}`);
    expect(summary).toContain("create MX example.org on");
    expect(summary).toContain("update TXT example.org off");
    expect(summary).toContain("delete MX example.org off");
    expect(summary.filter((line) => line.startsWith("create TXT") && line.includes("._domainkey."))).toHaveLength(2);
    expect(summary.some((line) => line.includes("google"))).toBe(false);

    const selected = plan.changes.filter(({ selected: on }) => on).map(({ id }) => id);
    const result = await dns.apply(server.id, domain.id, { fingerprint: plan.fingerprint, changeIds: selected });
    expect(result.results.every(({ ok }) => ok)).toBe(true);
    const records = cloudflare.records("example.org");
    expect(records.filter(({ type }) => type === "MX").map(({ content }) => content).sort()).toEqual(["mail.example.org", "old-mx.example.net"]);
    expect(records.find(({ content }) => content === "\"v=spf1 include:old.example -all\"")).toBeDefined();
    expect(records.find(({ type, name }) => type === "SRV" && name === "_imaps._tcp.example.org")).toMatchObject({ data: { priority: 0, weight: 1, port: 993, target: "mail.example.org" }, comment: "Managed by Postreeve", ttl: 300 });

    const again = await dns.plan(server.id, domain.id);
    expect(again.changes.map(({ action, owned }) => ({ action, owned }))).toEqual([
      { action: "update", owned: false }, { action: "delete", owned: false },
    ]);
    // The owner ticks the foreign SPF update and the foreign MX delete individually.
    await dns.apply(server.id, domain.id, { fingerprint: again.fingerprint, changeIds: again.changes.map(({ id }) => id) });
    expect(cloudflare.records("example.org").filter(({ type }) => type === "MX").map(({ content }) => content)).toEqual(["mail.example.org"]);
    expect((await dns.plan(server.id, domain.id)).changes).toEqual([]);

    // A DKIM key that disappears from Stalwart becomes a stale record Postreeve created.
    const keys = stalwart.list("DkimSignature").filter((key) => key.domainId === domain.id);
    stalwart.objects.get("DkimSignature")!.delete(String(keys[0]!.id));
    const stale = await dns.plan(server.id, domain.id);
    expect(stale.changes).toEqual([expect.objectContaining({ action: "delete", type: "TXT", owned: true, selected: true })]);
  });

  test("refuses to apply when records changed since the review, or an unknown change is selected", async () => {
    const { dns, cloudflare, admin, server } = await harness();
    const domain = await admin.addDomain(server.id, "example.org");
    cloudflare.addZone("example.org", foreignRecords);
    await dns.connect({ name: "CF", credential: { kind: "cloudflare", apiToken: cloudflare.token } });
    const plan = await dns.plan(server.id, domain.id);
    await expect(dns.apply(server.id, domain.id, { fingerprint: plan.fingerprint, changeIds: ["nope"] })).rejects.toThrow("not in the current plan");
    cloudflare.records("example.org").push({ id: "late", type: "TXT", name: "_dmarc.example.org", content: "v=DMARC1; p=none" });
    await expect(dns.apply(server.id, domain.id, { fingerprint: plan.fingerprint, changeIds: [plan.changes[0]!.id] })).rejects.toThrow("changed since you reviewed");
    expect(cloudflare.requests.filter(({ method }) => method !== "GET")).toEqual([]);
  });

  test("a domain no provider holds gets no changes", async () => {
    const { dns, cloudflare, admin, server } = await harness();
    const domain = await admin.addDomain(server.id, "example.com");
    cloudflare.addZone("example.org");
    await dns.connect({ name: "CF", credential: { kind: "cloudflare", apiToken: cloudflare.token } });
    expect(await dns.plan(server.id, domain.id)).toMatchObject({ status: "no-provider", changes: [], reason: "No connected DNS provider has a zone for example.com" });
  });
});

describe("GoDaddy", () => {
  test("edits record sets, leaves SRV to the checklist and falls back on 403", async () => {
    const { dns, godaddy, admin, server } = await harness();
    const domain = await admin.addDomain(server.id, "example.net");
    godaddy.domains.set("example.net", [{ type: "MX", name: "@", data: "old-mx.example.com", priority: 10, ttl: 3600 }, { type: "A", name: "@", data: "203.0.113.7", ttl: 3600 }]);
    await expect(dns.connect({ name: "GD", credential: { kind: "godaddy", apiKey: "x", apiSecret: "y" } })).rejects.toThrow("GoDaddy rejected the API key");
    await dns.connect({ name: "GD", credential: { kind: "godaddy", apiKey: godaddy.key, apiSecret: godaddy.secret } });
    const plan = await dns.plan(server.id, domain.id);
    expect(plan.status).toBe("ready");
    expect(plan.manual.map(({ type }) => type)).toContain("SRV");
    expect(plan.changes.some(({ type }) => type === "SRV")).toBe(false);
    await dns.apply(server.id, domain.id, { fingerprint: plan.fingerprint, changeIds: plan.changes.filter(({ selected }) => selected).map(({ id }) => id) });
    const records = godaddy.domains.get("example.net")!;
    expect(records.filter(({ type }) => type === "MX").map(({ data }) => data).sort()).toEqual(["mail.example.org", "old-mx.example.com"]);
    expect(records.find(({ type, name }) => type === "TXT" && name === "_dmarc")).toMatchObject({ data: "v=DMARC1; p=reject; rua=mailto:postmaster@example.net", ttl: 600 });
    expect(records.find(({ type }) => type === "A")).toBeDefined();

    const again = await dns.plan(server.id, domain.id);
    const foreignMx = again.changes.find(({ action, type }) => action === "delete" && type === "MX")!;
    await dns.apply(server.id, domain.id, { fingerprint: again.fingerprint, changeIds: [foreignMx.id] });
    expect(godaddy.domains.get("example.net")!.filter(({ type }) => type === "MX").map(({ data }) => data)).toEqual(["mail.example.org"]);

    godaddy.denyRecords = true;
    const denied = await dns.plan(server.id, domain.id);
    expect(denied).toMatchObject({ status: "unavailable", changes: [] });
    expect(denied.reason).toContain("limits its production DNS API");
    expect(denied.manual.length).toBeGreaterThan(5);
  });
});

describe("approval boundary", () => {
  test("an approved applyDnsChanges proposal applies only the default selection", async () => {
    const { dns, cloudflare, admin, server } = await harness();
    await admin.addDomain(server.id, "example.org");
    cloudflare.addZone("example.org", foreignRecords);
    await dns.connect({ name: "CF", credential: { kind: "cloudflare", apiToken: cloudflare.token } });
    const proposal = admin.createProposal(server.id, { title: "DNS", operations: [{ type: "applyDnsChanges", domain: "example.org" }] }, "agent");
    expect(cloudflare.requests.filter(({ method }) => method !== "GET")).toEqual([]);
    const applied = await admin.approveProposal(proposal.id, {});
    expect(applied.status).toBe("applied");
    expect(applied.results[0]!.message).toMatch(/^Published \d+ DNS changes$/);
    const records = cloudflare.records("example.org");
    expect(records.find(({ content }) => content === "old-mx.example.net")).toBeDefined();
    expect(records.find(({ content }) => content === "\"v=spf1 include:old.example -all\"")).toBeDefined();
  });

  test("routes list providers without secrets and apply only with the reviewed fingerprint", async () => {
    const { dns, cloudflare, admin, server } = await harness();
    const domain = await admin.addDomain(server.id, "example.org");
    cloudflare.addZone("example.org");
    const app = createDnsProviderRoutes(dns);
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/dns-providers", { name: "CF", credential: { kind: "cloudflare", apiToken: cloudflare.token } })).status).toBe(201);
    expect(await (await app.request("/api/dns-providers")).text()).not.toContain(cloudflare.token);
    const plan = await (await app.request(`/api/mail-servers/${server.id}/domains/${domain.id}/dns/plan`)).json() as { fingerprint: string; changes: { id: string }[] };
    expect((await post(`/api/mail-servers/${server.id}/domains/${domain.id}/dns/apply`, { fingerprint: "stale", changeIds: [] })).status).toBe(409);
    const applied = await post(`/api/mail-servers/${server.id}/domains/${domain.id}/dns/apply`, { fingerprint: plan.fingerprint, changeIds: plan.changes.map(({ id }) => id) });
    expect(applied.status).toBe(200);
  });
});
