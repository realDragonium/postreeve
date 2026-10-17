import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { agentTiers, createPersonalTokenInputSchema, tierOf, type ConnectedAgent } from "../../shared/agent-access";
import type { PostreeveService } from "../core/postreeve";
import { handleMcpRequest } from "../mcp/server";
import { createServerAgentServices } from "../mcp/services";
import { getOwnerSession as defaultGetOwnerSession, requireOwner as defaultRequireOwner } from "../security/owner-auth";
import { authenticateBearer, oauthRoutes, publicOrigin, resourceMetadataUrl } from "./oauth";
import type { AgentAccessStore, AgentGrant } from "./store";

export interface AgentAccessOptions {
  readonly service: PostreeveService;
  readonly store: AgentAccessStore;
  /** `POSTREEVE_PUBLIC_URL`; without it the request origin is used, which is right on loopback. */
  readonly publicUrl?: string | undefined;
  readonly getOwnerSession?: (c: Context) => unknown;
  readonly requireOwner?: MiddlewareHandler;
}

export function toConnectedAgent(grant: AgentGrant): ConnectedAgent {
  return {
    id: grant.id, kind: grant.kind, name: grant.name, redirectHost: grant.redirectHost, tier: tierOf(grant.scopes),
    scopes: [...grant.scopes], accountIds: grant.accountIds ? [...grant.accountIds] : null,
    createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt,
  };
}

// Bearer-only endpoints: no cookie is ever read, so any origin may call them.
const publicCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
  exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"],
  maxAge: 600,
});

/**
 * Remote agent access: OAuth metadata and endpoints, the `/mcp` endpoint and the owner's
 * Connected agents API. Mounted at the root before the web bundle's fallback route.
 */
export function createAgentAccess(options: AgentAccessOptions) {
  const { service, store } = options;
  const getOwnerSession = options.getOwnerSession ?? defaultGetOwnerSession;
  const requireOwner = options.requireOwner ?? defaultRequireOwner;
  const app = new Hono();

  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke", "/mcp"]) app.use(path, publicCors);
  app.route("/", oauthRoutes({ store, listAccounts: () => service.listAccounts(), getOwnerSession, publicUrl: options.publicUrl }));

  app.post("/mcp", async (c) => {
    const origin = publicOrigin(c, options.publicUrl);
    const authorization = c.req.header("Authorization");
    const agent = authenticateBearer(store, authorization, origin);
    if (!agent) {
      const error = authorization ? ', error="invalid_token", error_description="The access token is invalid, expired or revoked"' : "";
      c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl(origin)}"${error}`);
      return c.json({ error: authorization ? "invalid_token" : "unauthorized" }, 401);
    }
    const grantScopes = agent.grant.scopes;
    return handleMcpRequest(c.req.raw, {
      grant: agent.grant,
      scopes: agent.token.scopes.filter((scope) => grantScopes.includes(scope)),
      services: createServerAgentServices(service, agent.grant.accountIds),
      store,
    });
  });
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "This endpoint accepts POST only; server-sent streams and sessions are not offered" }, 405);
  });

  const agentApi = new Hono()
    .use("*", requireOwner)
    .get("/agents", (c) => c.json(store.listActiveGrants().map(toConnectedAgent)))
    .delete("/agents/:grantId", (c) => {
      if (!store.revokeGrant(c.req.param("grantId"))) return c.json({ error: "Agent not found" }, 404);
      return c.json({ ok: true as const });
    })
    .post("/tokens", zValidator("json", createPersonalTokenInputSchema), async (c) => {
      const input = c.req.valid("json");
      if (input.accountIds) {
        const known = new Set((await service.listAccounts()).map(({ id }) => id));
        if (input.accountIds.some((id) => !known.has(id))) return c.json({ error: "Account not found" }, 400);
      }
      const scopes = agentTiers[input.tier].scopes;
      const grant = store.createGrant({
        kind: "token", clientId: null, name: input.name, redirectHost: null, scopes,
        accountIds: input.accountIds ? [...new Set(input.accountIds)] : null,
      });
      const token = store.issueToken(grant.id, "personal", scopes, null, null);
      c.header("Cache-Control", "no-store");
      return c.json({ agent: toConnectedAgent(grant), token }, 201);
    })
    .get("/events", zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) })), (c) =>
      c.json(store.listEvents(c.req.valid("query").limit)));
  app.route("/api/agent-access", agentApi);

  return app;
}
