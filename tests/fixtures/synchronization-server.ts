import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { createApi } from "../../src/server/api";
import { SynchronizationError, type MailSynchronization } from "../../src/server/mail/synchronization";
import { createEmptyTestHarness, testAccountInput } from "../support/test-mail";

const harness = await createEmptyTestHarness();
const account = await harness.service.createAccount(testAccountInput());
let failure: "provider" | "reauthorization" | null = "provider";
const adapter: MailSynchronization = {
  async discoverScopes() { return [{ kind: "mailbox", mailbox: "INBOX" }]; },
  async fetchPage() {
    if (failure) throw new SynchronizationError(failure);
    return { messages: [], removed: [], cursor: "done", hasMore: false, coverage: "complete" };
  },
};
Object.assign(harness.providerForAccount(account.id)!, { synchronization: adapter });
await harness.service.synchronization.runOnce();
harness.service.synchronization.start();
const app = new Hono();
app.post("/scenario", async context => {
  failure = z.object({ failure: z.enum(["provider", "reauthorization"]).nullable() }).parse(await context.req.json()).failure;
  return context.json({ ok: true });
});
app.route("/", createApi(harness.service));
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(`http://127.0.0.1:${server.port}`);
