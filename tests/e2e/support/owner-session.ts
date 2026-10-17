import { test as base, type Page } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Page, Route } from "@playwright/test";

/** Makes the page see a signed-in owner; the `test` fixture does this for its own `page`. */
export async function stubOwnerSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const now = new Date().toISOString();
    const state = {
      state: "authenticated",
      passkeys: false,
      desktop: false,
      session: { id: "e2e-session", method: "password", createdAt: now, lastSeenAt: now, expiresAt: now },
    };
    const stubbed = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(target, window.location.href).pathname === "/api/auth/session") {
        return Promise.resolve(new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json" } }));
      }
      return original(input, init);
    };
    window.fetch = Object.assign(stubbed, { preconnect: window.fetch.preconnect });
  });
}

/**
 * Specs that mock the mailbox API run as a signed-in owner: the page sees an authenticated
 * `/api/auth/session` before its own code loads, whatever `/api/**` routes the spec installs.
 * The real sign-in flow is covered by owner-auth.spec.ts against a real server.
 */
export const test = base.extend<{ ownerSession: void }>({
  ownerSession: [async ({ page }, use) => {
    await stubOwnerSession(page);
    await use();
  }, { auto: true }],
});
