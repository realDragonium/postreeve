import { expect, test, type Page, type Route } from "./support/owner-session";
import type { Account } from "../../src/shared/contracts";
import type { DnsPlan } from "../../src/shared/dns-providers";
import type { DnsChecklist, MailDomain, MailServerSummary } from "../../src/shared/mail-server";

const account: Account = { id: "account-1", name: "Owner", email: "owner@example.org", kind: "imap" };
const server: MailServerSummary = {
  id: "7b0c4a1e-1d7a-4b5e-9a49-6f3a2a1c0d11", name: "Contabo", baseUrl: "http://stalwart:8080", credentialKind: "apiKey",
  mailHostname: "mail.example.org", createdAt: "2026-10-17T09:00:00.000Z", updatedAt: "2026-10-17T09:00:00.000Z", domainCount: 1, error: null,
};
const domain: MailDomain = { id: "b", name: "example.org", enabled: true, aliases: [], catchAll: null, dkimManagement: "automatic" };
const plan: DnsPlan = {
  domain: "example.org", status: "ready", providerId: "p1", providerName: "Cloudflare", zone: "example.org", reason: null,
  fingerprint: "fp-1", inSync: 3, manual: [],
  changes: [
    { id: "c1", action: "create", type: "TXT", name: "v1-rsa._domainkey.example.org", from: null, to: "v=DKIM1; k=rsa; p=AAA", owned: true, selected: true, reason: "Required by the mail server and missing" },
    { id: "c2", action: "update", type: "TXT", name: "example.org", from: "v=spf1 include:old.example -all", to: "v=spf1 mx -all", owned: false, selected: false, reason: "Not created by Postreeve; tick it to replace its value" },
    { id: "c3", action: "delete", type: "MX", name: "example.org", from: "10 old-mx.example.net", to: null, owned: false, selected: false, reason: "Not created by Postreeve; mail for this name would also go to another server. Tick it to remove" },
  ],
};
const checklist: DnsChecklist = { domain: "example.org", zone: "example.org. IN MX 10 mail.example.org.\n", resolver: "test", checkedAt: "2026-10-17T09:00:00.000Z",
  records: [{ category: "mx", name: "example.org.", type: "MX", value: "10 mail.example.org.", status: "ok", found: ["10 mail.example.org."], error: null }] };

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function mockServer(page: Page, calls: { apply: unknown[]; deletes: unknown[] }) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const base = `/api/mail-servers/${server.id}`;
    if (method === "GET" && pathname === "/api/accounts") return json(route, [account]);
    if (method === "GET" && pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "GET" && pathname.startsWith(`/api/accounts/${account.id}/`)) return json(route, []);
    if (method === "POST" && pathname === "/api/messages/query") return json(route, { messages: [], nextCursor: null, coverage: { sources: [], complete: true, bodyTextLimit: 32768 } });
    if (method === "GET" && (pathname === "/api/proposals" || pathname === "/api/batches")) return json(route, []);
    if (method === "GET" && pathname === "/api/mail-servers") return json(route, [server]);
    if (method === "GET" && pathname === "/api/mail-servers/proposals") return json(route, []);
    if (method === "GET" && pathname === `${base}/domains`) return json(route, [domain]);
    if (method === "GET" && pathname === `${base}/domains/b/mailboxes`) return json(route, []);
    if (method === "GET" && pathname === `${base}/domains/b/dns/plan`) return json(route, plan);
    if (method === "GET" && pathname === `${base}/domains/b/dns`) return json(route, checklist);
    if (method === "POST" && pathname === `${base}/domains/b/dns/apply`) {
      calls.apply.push(request.postDataJSON());
      return json(route, { domain: "example.org", results: [{ id: "c1", ok: true, message: "Created TXT" }] });
    }
    if (method === "DELETE" && pathname === `${base}/domains/b`) {
      calls.deletes.push(request.postDataJSON());
      return json(route, { ok: true });
    }
    return json(route, { error: `Unhandled test route: ${method} ${pathname}` }, 404);
  });
}

test("applies only the DNS changes the owner selected, and deleting a domain needs its name", async ({ page }) => {
  const calls = { apply: [] as unknown[], deletes: [] as unknown[] };
  await mockServer(page, calls);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Mail server", { exact: true }).first().click();
  await page.getByRole("button", { name: "DNS", exact: true }).click();

  await expect(page.getByRole("checkbox", { name: "create TXT v1-rsa._domainkey.example.org" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "update TXT example.org" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "delete MX example.org" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "delete MX example.org" }).check();
  await page.getByRole("button", { name: "Review and apply 2" }).click();
  await expect(page.getByText("1 of these changes a record Postreeve did not create.")).toBeVisible();
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect.poll(() => calls.apply).toEqual([{ fingerprint: "fp-1", changeIds: ["c1", "c3"] }]);

  await page.getByRole("button", { name: "Delete domain" }).click();
  const confirm = page.getByRole("button", { name: "Delete domain" }).last();
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type example.org to confirm").fill("example.org");
  await confirm.click();
  await expect.poll(() => calls.deletes).toEqual([{ confirm: "example.org" }]);
});
