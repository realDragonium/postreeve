import { execSync, spawn, type ChildProcess } from "node:child_process";
import { expect, test as base, type Page } from "@playwright/test";

const SETUP_TOKEN = "e2e-setup-token-0123456789";
const PASSWORD = "correct horse battery";

// Signs in for real against a real server, so it deliberately skips the stubbed owner session.
const test = base.extend<{ server: string }>({
  server: async ({}, use) => {
    const child: ChildProcess = spawn("bun", ["--no-env-file", "tests/fixtures/owner-auth-server.ts"], { stdio: ["ignore", "pipe", "pipe"] });
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`Owner auth server exited with ${code}`)));
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /http:\/\/localhost:\d+/.exec(output);
        if (match) resolve(match[0]);
      });
    });
    try {
      await use(url);
    } finally {
      child.kill();
    }
  },
});

// One worker builds the bundle once; parallel builds would rewrite dist while another test's server reads it.
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // The real server serves the production bundle.
  execSync("bun run build", { stdio: "ignore" });
});

async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function installWebMcpHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools = new Map<string, { execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown> }>();
    Object.defineProperty(document, "modelContext", {
      value: {
        async registerTool(tool: { name: string; execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown> }) {
          tools.set(tool.name, tool);
        },
      },
    });
    Reflect.set(window, "postreeveWebMcp", (name: string, input: unknown) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool: ${name}`);
      return tool.execute(input, { signal: new AbortController().signal });
    });
  });
}

test("sets up the owner, adds a passkey, and signs in with it and with the password", async ({ page, request, server }) => {
  test.setTimeout(60_000);
  await addVirtualAuthenticator(page);
  await installWebMcpHarness(page);

  expect((await request.get(`${server}/api/accounts`)).status()).toBe(401);

  await page.goto(`${server}/`);
  await expect(page.getByRole("heading", { name: "Set up Postreeve" })).toBeVisible();
  await page.getByLabel("Setup token").fill("not-the-setup-token");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create owner" }).click();
  await expect(page.getByRole("alert")).toHaveText("Incorrect setup token");

  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByRole("button", { name: "Create owner" }).click();
  await expect(page.getByRole("heading", { name: "Add a passkey" })).toBeVisible();
  await page.getByLabel("Passkey name").fill("Virtual key");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByRole("button", { name: "New message", exact: true })).toBeVisible();

  // WebMCP tools run in the signed-in page, so their API calls carry the session cookie.
  const accounts = await page.evaluate(() => (Reflect.get(window, "postreeveWebMcp") as (name: string, input: unknown) => Promise<unknown>)("list_accounts", {}));
  expect(JSON.stringify(accounts)).toContain("person@example.test");
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === "postreeve-session")).toMatchObject({ httpOnly: true, sameSite: "Lax" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByLabel("Passkeys").getByText("Virtual key")).toBeVisible();
  await expect(page.getByLabel("Sessions").getByText("this browser")).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("button", { name: "New message", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByLabel("Passkeys").getByText(/Used /)).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Incorrect password");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("button", { name: "New message", exact: true })).toBeVisible();
});

test("returns to sign-in when the session is revoked elsewhere", async ({ browser, page, server }) => {
  await page.goto(`${server}/`);
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create owner" }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("button", { name: "New message", exact: true })).toBeVisible();

  const other = await browser.newPage();
  try {
    await other.goto(`${server}/`);
    await other.getByLabel("Password").fill(PASSWORD);
    await other.getByRole("button", { name: "Sign in with password" }).click();
    await other.getByRole("button", { name: "Settings", exact: true }).click();
    await other.getByRole("button", { name: "Security", exact: true }).click();
    await other.getByRole("button", { name: "Sign out other sessions" }).click();
    await expect(other.getByText("Signed out 1 other session.")).toBeVisible();
  } finally {
    await other.close();
  }

  // The next API call from the first browser finds its session gone.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
