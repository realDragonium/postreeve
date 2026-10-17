import type { Context } from "hono";
import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { agentScopeSchema, agentScopes, agentTierSchema, agentTiers, tierOf, type AgentScope, type AgentTier } from "../../shared/agent-access";
import type { Account } from "../../shared/contracts";
import { hashSecret, type AgentAccessStore, type AgentClient, type AgentGrant, type ClientAuthMethod, type StoredToken } from "./store";
import { consentPage, noticePage, signInPage } from "./pages";

export const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const PENDING_LIFETIME_MS = 10 * 60 * 1000;
const UNUSED_CLIENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Two concurrent refreshes from one client must not look like token theft.
const ROTATION_GRACE_MS = 30 * 1000;
const MAX_PENDING = 100;

export interface OAuthDependencies {
  readonly store: AgentAccessStore;
  readonly listAccounts: () => Promise<Account[]>;
  readonly getOwnerSession: (c: Context) => unknown;
  /** Origin of the web UI and the consent page (`POSTREEVE_PUBLIC_URL`). */
  readonly publicUrl?: string | undefined;
  /** Origin agents reach (`POSTREEVE_MCP_PUBLIC_URL`, e.g. a Funnel port); issuer and resource live here. */
  readonly mcpPublicUrl?: string | undefined;
  /** false on the public listener: the consent page needs the owner's session and stays private. */
  readonly authorize?: boolean;
}

export function publicOrigin(c: Context, publicUrl: string | undefined): string {
  return new URL(publicUrl?.trim() || c.req.url).origin;
}

/**
 * The issuer must equal the origin its metadata is fetched from (RFC 8414), so it follows the
 * agent-facing origin; only the consent page stays on the UI origin.
 */
export function issuerOrigin(c: Context, urls: { publicUrl?: string | undefined; mcpPublicUrl?: string | undefined }): string {
  return publicOrigin(c, urls.mcpPublicUrl?.trim() || urls.publicUrl);
}

export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function validRedirectUri(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname));
}

/** Loopback redirects may change port between runs (RFC 8252 §7.3); everything else must match exactly. */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const left = new URL(registered);
    const right = new URL(requested);
    return left.protocol === "http:" && loopbackHosts.has(left.hostname) && left.protocol === right.protocol
      && left.hostname === right.hostname && left.pathname === right.pathname && left.search === right.search;
  } catch {
    return false;
  }
}

function sameSecretHash(stored: string, presented: string): boolean {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(hashSecret(presented), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const pkceValue = /^[A-Za-z0-9\-._~]{43,128}$/;

function requestedScopes(value: string | undefined): AgentScope[] {
  return (value ?? "").split(" ").flatMap((scope) => agentScopeSchema.safeParse(scope).success ? [scope as AgentScope] : []);
}

function oauthError(c: Context, status: 400 | 401, error: string, description: string) {
  c.header("Cache-Control", "no-store");
  if (status === 401) c.header("WWW-Authenticate", 'Basic realm="postreeve"');
  return c.json({ error, error_description: description }, status);
}

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
}).passthrough();

interface PendingAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly resource: string;
  readonly expiresAt: number;
}

export interface AuthenticatedAgent {
  readonly grant: AgentGrant;
  readonly token: StoredToken;
}

/** Resolves a bearer token for `/mcp`; null means 401. */
export function authenticateBearer(store: AgentAccessStore, authorization: string | undefined, origin: string): AuthenticatedAgent | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) return null;
  const token = store.findToken(match[1]!);
  if (!token || token.revokedAt || token.kind === "refresh") return null;
  if (token.expiresAt && token.expiresAt <= store.now().toISOString()) return null;
  if (token.resource && token.resource !== resourceUrl(origin)) return null;
  const grant = store.getGrant(token.grantId);
  if (!grant || grant.revokedAt) return null;
  return { grant, token };
}

export function oauthRoutes(deps: OAuthDependencies) {
  const { store } = deps;
  const pending = new Map<string, PendingAuthorization>();
  const origin = (c: Context) => issuerOrigin(c, deps);
  const uiOrigin = (c: Context) => publicOrigin(c, deps.publicUrl);

  function takePending(id: string): PendingAuthorization | null {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
    const found = pending.get(id) ?? null;
    pending.delete(id);
    return found;
  }

  function redirectWith(redirectUri: string, params: Record<string, string | undefined>, issuer: string): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...params, iss: issuer })) if (value !== undefined) url.searchParams.set(key, value);
    return url.toString();
  }

  function authenticateClient(c: Context, form: Record<string, string>): AgentClient | null {
    let clientId = form.client_id;
    let secret = form.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator < 0) return null;
      clientId = decodeURIComponent(decoded.slice(0, separator));
      secret = decodeURIComponent(decoded.slice(separator + 1));
    }
    if (!clientId) return null;
    const client = store.getClient(clientId);
    if (!client) return null;
    if (client.authMethod === "none") return client;
    return client.secretHash && secret && sameSecretHash(client.secretHash, secret) ? client : null;
  }

  function tokenResponse(c: Context, grant: AgentGrant, scopes: readonly AgentScope[], resource: string) {
    const accessToken = store.issueToken(grant.id, "access", scopes, resource, ACCESS_TOKEN_LIFETIME_MS);
    const refreshToken = store.issueToken(grant.id, "refresh", scopes, resource, REFRESH_TOKEN_LIFETIME_MS);
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json({
      access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_LIFETIME_MS / 1000,
      refresh_token: refreshToken, scope: scopes.join(" "),
    });
  }

  async function formOf(c: Context): Promise<Record<string, string>> {
    const body = await c.req.parseBody({ all: true }).catch(() => ({}));
    return Object.fromEntries(Object.entries(body).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []));
  }

  const app = new Hono();
  // Agent-facing endpoints: served on the public listener too.
  app
    .get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource(origin(c))))
    .get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource(origin(c))))
    .get("/.well-known/oauth-authorization-server", (c) => {
      const issuer = origin(c);
      return c.json({
        issuer,
        authorization_endpoint: `${uiOrigin(c)}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        scopes_supported: agentScopes,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        authorization_response_iss_parameter_supported: true,
        service_documentation: `${issuer}/`,
      });
    })
    .post("/oauth/register", async (c) => {
      const parsed = registrationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "invalid_client_metadata", error_description: "Expected redirect_uris and valid client metadata" }, 400);
      const input = parsed.data;
      const invalid = input.redirect_uris.find((uri) => !validRedirectUri(uri));
      if (invalid !== undefined) {
        return c.json({ error: "invalid_redirect_uri", error_description: "Redirect URIs must use https, or http on a loopback host" }, 400);
      }
      store.pruneUnusedClients(UNUSED_CLIENT_LIFETIME_MS);
      // Most MCP clients omit the method and use PKCE as public clients, so that is the default.
      const authMethod: ClientAuthMethod = input.token_endpoint_auth_method ?? "none";
      const { client, secret } = store.registerClient({ name: input.client_name ?? "Unnamed agent", redirectUris: input.redirect_uris, authMethod });
      c.header("Cache-Control", "no-store");
      return c.json({
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.authMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      }, 201);
    })
    .post("/oauth/token", async (c) => {
      const form = await formOf(c);
      const client = authenticateClient(c, form);
      if (!client) return oauthError(c, 401, "invalid_client", "Client authentication failed");
      const issuer = origin(c);
      const now = store.now().toISOString();

      if (form.grant_type === "authorization_code") {
        if (!form.code || !form.code_verifier || !pkceValue.test(form.code_verifier)) {
          return oauthError(c, 400, "invalid_request", "code and a valid code_verifier are required");
        }
        const code = store.consumeCode(form.code);
        if (!code) return oauthError(c, 400, "invalid_grant", "Unknown authorization code");
        if (code.usedAt) {
          // A replayed code may have been stolen: end everything issued from it.
          store.revokeGrant(code.grantId);
          return oauthError(c, 400, "invalid_grant", "Authorization code was already used");
        }
        if (code.expiresAt <= now || code.clientId !== client.id
          || (form.redirect_uri !== undefined && form.redirect_uri !== code.redirectUri)
          || pkceChallenge(form.code_verifier) !== code.codeChallenge) {
          return oauthError(c, 400, "invalid_grant", "Authorization code is invalid, expired, or does not match");
        }
        const grant = store.getGrant(code.grantId);
        if (!grant || grant.revokedAt) return oauthError(c, 400, "invalid_grant", "Authorization was revoked");
        return tokenResponse(c, grant, grant.scopes, code.resource ?? resourceUrl(issuer));
      }

      if (form.grant_type === "refresh_token") {
        const token = form.refresh_token ? store.findToken(form.refresh_token) : null;
        if (!token || token.kind !== "refresh") return oauthError(c, 400, "invalid_grant", "Unknown refresh token");
        const grant = store.getGrant(token.grantId);
        if (!grant || grant.revokedAt || grant.clientId !== client.id) return oauthError(c, 400, "invalid_grant", "Authorization was revoked");
        if (token.revokedAt) {
          if (Date.parse(now) - Date.parse(token.revokedAt) > ROTATION_GRACE_MS) store.revokeGrant(grant.id);
          return oauthError(c, 400, "invalid_grant", "Refresh token was already used");
        }
        if (token.expiresAt && token.expiresAt <= now) return oauthError(c, 400, "invalid_grant", "Refresh token expired");
        let scopes = token.scopes;
        if (form.scope !== undefined) {
          const asked = requestedScopes(form.scope);
          if (asked.length === 0 || asked.some((scope) => !token.scopes.includes(scope))) {
            return oauthError(c, 400, "invalid_scope", "A refresh can only keep or narrow the granted scope");
          }
          scopes = asked;
        }
        store.revokeToken(token.hash);
        return tokenResponse(c, grant, scopes, token.resource ?? resourceUrl(issuer));
      }

      return oauthError(c, 400, "unsupported_grant_type", "Use authorization_code or refresh_token");
    })
    .post("/oauth/revoke", async (c) => {
      const form = await formOf(c);
      const token = form.token ? store.findToken(form.token) : null;
      if (token) {
        if (token.kind === "access") store.revokeToken(token.hash);
        else store.revokeGrant(token.grantId);
      }
      c.header("Cache-Control", "no-store");
      return c.body(null, 200);
    });
  if (deps.authorize === false) return app;
  // The consent page needs the owner's session, so it stays on the private (UI) listener.
  app
    .get("/oauth/authorize", async (c) => {
      const query = c.req.query();
      const issuer = origin(c);
      const client = query.client_id ? store.getClient(query.client_id) : null;
      if (!client) return c.html(noticePage("Unknown agent", "This connection request names an agent Postreeve does not know. Start the connection again from the agent."), 400);
      const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
      if (!redirectUri || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
        return c.html(noticePage("Invalid redirect", "This connection request returns to an address the agent did not register."), 400);
      }
      const fail = (error: string, description: string) =>
        c.redirect(redirectWith(redirectUri, { error, error_description: description, state: query.state }, issuer));
      if (query.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
      if (!query.code_challenge || !pkceValue.test(query.code_challenge) || query.code_challenge_method !== "S256") {
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
      }
      const resource = query.resource?.replace(/\/$/, "");
      if (resource !== undefined && resource !== issuer && resource !== resourceUrl(issuer)) {
        return fail("invalid_target", "The requested resource is not this Postreeve server");
      }
      if (!await deps.getOwnerSession(c)) return c.html(signInPage(), 401);

      takePending("");
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
      const requestId = crypto.randomUUID() + crypto.randomUUID();
      pending.set(requestId, {
        clientId: client.id, redirectUri, codeChallenge: query.code_challenge, state: query.state,
        resource: resourceUrl(issuer), expiresAt: Date.now() + PENDING_LIFETIME_MS,
      });
      const scopes = requestedScopes(query.scope);
      const tier: AgentTier = scopes.length === 0 ? "propose" : tierOf(scopes);
      c.header("Cache-Control", "no-store");
      return c.html(consentPage({
        requestId, clientName: client.name, redirectHost: new URL(redirectUri).host, tier, accounts: await deps.listAccounts(),
      }));
    })
    .post("/oauth/authorize", async (c) => {
      const issuer = origin(c);
      const requestOrigin = c.req.header("Origin");
      if (requestOrigin !== undefined && requestOrigin !== uiOrigin(c) && requestOrigin !== new URL(c.req.url).origin) {
        return c.html(noticePage("Request refused", "The consent form must be sent from this Postreeve page."), 403);
      }
      if (!await deps.getOwnerSession(c)) return c.html(signInPage(), 401);
      const body = await c.req.parseBody({ all: true });
      const request = typeof body.request_id === "string" ? takePending(body.request_id) : null;
      if (!request) return c.html(noticePage("Request expired", "This connection request expired or was already answered. Start it again from the agent."), 400);
      if (body.decision !== "allow") {
        return c.redirect(redirectWith(request.redirectUri, { error: "access_denied", state: request.state }, issuer), 303);
      }
      const tier = agentTierSchema.safeParse(body.tier);
      const client = store.getClient(request.clientId);
      if (!tier.success || !client) return c.html(noticePage("Invalid choice", "Choose what the agent may do and try again."), 400);
      let accountIds: string[] | null = null;
      if (body.scope_accounts === "chosen") {
        const known = new Set((await deps.listAccounts()).map(({ id }) => id));
        const chosen = [body.account].flat().filter((value): value is string => typeof value === "string" && known.has(value));
        if (chosen.length === 0) return c.html(noticePage("No account chosen", "Choose at least one account, or all accounts."), 400);
        accountIds = [...new Set(chosen)];
      }
      const grant = store.createGrant({
        kind: "oauth", clientId: client.id, name: client.name, redirectHost: new URL(request.redirectUri).host,
        scopes: agentTiers[tier.data].scopes, accountIds,
      });
      const code = store.issueCode({
        grantId: grant.id, clientId: client.id, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
        resource: request.resource,
      }, CODE_LIFETIME_MS);
      return c.redirect(redirectWith(request.redirectUri, { code, state: request.state }, issuer), 303);
    });
  return app;
}

function protectedResource(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: agentScopes,
    bearer_methods_supported: ["header"],
    resource_name: "Postreeve mail",
    resource_documentation: `${origin}/`,
  };
}
