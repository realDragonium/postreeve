import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { createPublicAgentAccess, type AgentAccessOptions } from "../agent-access";
import { postreeveSecureHeaders } from "../security/headers";

/**
 * The only paths the public listener serves: the remote MCP endpoint and the OAuth endpoints a cloud connector calls
 * server-to-server. Each entry also admits its sub-paths, which covers the RFC 9728 path-suffixed
 * `/.well-known/oauth-protected-resource/mcp` that connectors fetch first. `/oauth/authorize` is deliberately absent:
 * the consent page needs the owner's login, so it stays on the tailnet origin.
 */
export const PUBLIC_PATHS = [
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
] as const;

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export interface PublicListenerConfig {
  readonly port: number;
  /** `POSTREEVE_MCP_PUBLIC_URL`, the https origin Caddy publishes this listener at. */
  readonly url: URL;
}

const environmentSchema = z.object({
  POSTREEVE_PUBLIC_MCP_PORT: z.string().trim().optional(),
  POSTREEVE_MCP_PUBLIC_URL: z.string().trim().optional(),
});

/** Off unless `POSTREEVE_PUBLIC_MCP_PORT` is set; then it requires an https `POSTREEVE_MCP_PUBLIC_URL`. */
export function publicListenerFromEnvironment(environment: Record<string, string | undefined>): PublicListenerConfig | null {
  const { POSTREEVE_PUBLIC_MCP_PORT: rawPort, POSTREEVE_MCP_PUBLIC_URL: rawUrl } = environmentSchema.parse(environment);
  if (!rawPort) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("POSTREEVE_PUBLIC_MCP_PORT must be an integer from 1 to 65535");
  }
  const url = rawUrl ? URL.parse(rawUrl) : null;
  if (!url || url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("POSTREEVE_PUBLIC_MCP_PORT requires POSTREEVE_MCP_PUBLIC_URL to be an https origin");
  }
  return { port, url };
}

/**
 * Answers a bare 404 to any path outside the allowlist and to any Host other than the published one, before any other
 * handler runs. Encoded characters are refused so no later layer decodes a different path than the one checked here.
 */
export function publicPathGuard(url: URL): MiddlewareHandler {
  return async (context, next) => {
    const host = URL.parse(`http://${context.req.header("Host") ?? ""}`)?.hostname.toLowerCase();
    const path = context.req.path;
    if (host !== url.hostname.toLowerCase() || /[%\\]/.test(path) || !isPublicPath(path)) {
      return context.body(null, 404);
    }
    return next();
  };
}

/** The internet-facing app: security headers, the guard, and only the agent endpoints. */
export function createPublicApp(config: PublicListenerConfig, agentAccess: AgentAccessOptions): Hono {
  const app = new Hono();
  app.use("*", postreeveSecureHeaders);
  app.use("*", publicPathGuard(config.url));
  app.route("/", createPublicAgentAccess({ ...agentAccess, mcpPublicUrl: config.url.origin }));
  app.notFound(context => context.body(null, 404));
  return app;
}
