import { Hono } from "hono";
import { z } from "zod";
import { createApi } from "../../src/server/api";
import { createEmptyTestHarness, testAccountInput } from "../support/test-mail";

const rejected: string[] = [];
let uncertain = false;
let attempts = 0;
const harness = await createEmptyTestHarness({
  rejectRecipients: rejected,
  maxUploadBytes: 1024,
  maxMessageBytes: 12000,
  sendFailure: () => uncertain ? new Error("Synthetic ambiguous delivery") : undefined,
  onSendAttempt: () => { attempts += 1; },
});
await harness.service.createAccount(testAccountInput());
const app = new Hono();
app.post("/scenario", async (context) => {
  const input = z.object({ reject: z.boolean(), uncertain: z.boolean() }).parse(await context.req.json());
  rejected.splice(0, rejected.length, ...(input.reject ? ["recipient@example.test"] : []));
  uncertain = input.uncertain;
  return context.json({ attempts });
});
app.get("/attempts", (context) => context.json({ attempts }));
app.route("/", createApi(harness.service));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(`http://127.0.0.1:${server.port}`);
