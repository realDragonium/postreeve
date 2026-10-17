import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { applyDnsPlanInputSchema, connectDnsProviderInputSchema } from "../../shared/dns-providers";
import { mailServerIdSchema } from "../../shared/mail-server";
import type { DnsProviders } from "./service";
import { DnsProviderError } from "./types";
import { MailServerError } from "../stalwart/jmap";

const provider = z.object({ providerId: z.uuid() });
const domain = z.object({ serverId: mailServerIdSchema, domainId: z.string().min(1).max(64).regex(/^[a-z0-9]+$/i) });

/** DNS provider routes. Applying changes is a human-facing route only; agents propose `applyDnsChanges` instead. */
export function createDnsProviderRoutes(dns: DnsProviders) {
  return new Hono()
    .basePath("/api")
    .get("/dns-providers", async (c) => c.json(await dns.list()))
    .post("/dns-providers", zValidator("json", connectDnsProviderInputSchema), async (c) => c.json(await dns.connect(c.req.valid("json")), 201))
    .delete("/dns-providers/:providerId", zValidator("param", provider), (c) => { dns.disconnect(c.req.valid("param").providerId); return c.json({ ok: true as const }); })
    .get("/mail-servers/:serverId/domains/:domainId/dns/plan", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await dns.plan(serverId, domainId));
    })
    .post("/mail-servers/:serverId/domains/:domainId/dns/apply", zValidator("param", domain), zValidator("json", applyDnsPlanInputSchema), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await dns.apply(serverId, domainId, c.req.valid("json")));
    })
    .onError((error, c) => {
      if (error instanceof DnsProviderError) return c.json({ error: error.message }, error.status);
      if (error instanceof MailServerError) return c.json({ error: error.message }, error.status === 401 ? 400 : error.status);
      if (error instanceof z.ZodError) return c.json({ error: error.issues.map((issue) => issue.message).join("; ") }, 400);
      return c.json({ error: error.message }, 400);
    });
}
