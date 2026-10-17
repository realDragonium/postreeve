import { expect, test, type Route } from "./support/owner-session";
import { createAccountInputSchema, type CreateAccountInput, type PresentedCertificate } from "../../src/shared/contracts";

const fingerprint = "a92cab64b20587d047c8d348faa24f2924dd6033d5f8d24360bfda1696364562";
const certificate: PresentedCertificate = {
  service: "imap", host: "192.168.1.20", port: 993, fingerprint,
  subject: "CN=mail.home.example", issuer: "CN=mail.home.example",
  validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", selfSigned: true,
};

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

test("reviews and trusts a self-signed IMAP certificate before connecting", async ({ page }) => {
  const tests: CreateAccountInput[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET" && url.pathname === "/api/accounts") return json(route, []);
    if (method === "GET" && url.pathname === "/api/oauth/google/status") return json(route, { configured: false });
    if (method === "POST" && url.pathname === "/api/accounts/test") {
      const input = createAccountInputSchema.parse(request.postDataJSON());
      tests.push(input);
      if (input.imapTrustedCertificate === fingerprint) return json(route, { ok: true });
      return json(route, {
        error: "The IMAP server's certificate could not be verified. Compare its fingerprint with the one your server shows, then trust it to connect.",
        code: "certificate_untrusted", certificate,
      }, 400);
    }
    return json(route, { error: `Unhandled test route: ${method} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connect account" }).click();
  await page.getByLabel("Email address").fill("owner@home.example");
  await page.getByLabel("Name", { exact: true }).fill("Home");
  await page.getByLabel("IMAP host").fill("192.168.1.20");
  await page.getByLabel("Username").first().fill("owner@home.example");
  await page.getByLabel(/Password/).first().fill("mailbox-password");
  await page.getByRole("button", { name: "Test connection" }).click();

  const review = page.getByRole("group", { name: "IMAP certificate" });
  await expect(review).toContainText("192.168.1.20:993 presented a certificate Postreeve cannot verify (self-signed)");
  await expect(review).toContainText("A9:2C:AB:64:B2:05:87:D0");
  await expect(review).toContainText("Subject: CN=mail.home.example");
  expect(tests[0]?.imapTrustedCertificate).toBeUndefined();

  await review.getByLabel("Trust this certificate for incoming mail (IMAP)").check();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("IMAP and SMTP connections succeeded.")).toBeVisible();
  expect(tests.at(-1)?.imapTrustedCertificate).toBe(fingerprint);
  expect(tests.at(-1)?.smtpTrustedCertificate).toBeUndefined();
});
