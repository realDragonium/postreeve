import { createServerApp } from "../../src/server/app";
import { OwnerAuth } from "../../src/server/security/owner-auth";
import { createEmptyTestHarness, testAccountInput } from "../support/test-mail";

const harness = await createEmptyTestHarness();
await harness.service.createAccount(testAccountInput());
const auth = new OwnerAuth({
  store: harness.store.owner,
  setupToken: "e2e-setup-token-0123456789",
  passwordCost: { memoryCost: 4096, timeCost: 1 },
});
const app = createServerApp({ service: harness.service, auth, hostname: "127.0.0.1", staticRoot: "./dist" });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch: app.fetch });
// Passkeys need a domain name, so the browser uses localhost rather than the IP address.
console.log(`http://localhost:${server.port}`);
