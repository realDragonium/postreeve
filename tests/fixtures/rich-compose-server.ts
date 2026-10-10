import { Hono } from "hono";
import { createApi } from "../../src/server/api";
import { createEmptyTestHarness, testAccountInput } from "../support/test-mail";

const harness = await createEmptyTestHarness();
const account = await harness.service.createAccount(testAccountInput());
await harness.service.addIdentity(account.id, { name: "Sales", address: "sales@example.test" });
const app = new Hono();
app.get("/sent", (context) => context.json(harness.sent));
app.route("/", createApi(harness.service));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(`http://127.0.0.1:${server.port}`);
