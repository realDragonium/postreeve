import type { MiddlewareHandler } from "hono";

/**
 * Tailscale sets this header to `?1` on every request that arrives through Funnel and deletes any copy the client
 * sent (ipn/ipnlocal/serve.go, addTailscaleIdentityHeaders), so it cannot be forged from the internet or stripped.
 */
export const FUNNEL_REQUEST_HEADER = "Tailscale-Funnel-Request";

/**
 * The only paths a Funnel (public internet) request may reach: the remote MCP endpoint and the OAuth endpoints a
 * cloud connector calls server-to-server. Each entry also admits its sub-paths, which covers the RFC 9728
 * path-suffixed `/.well-known/oauth-protected-resource/mcp` that connectors fetch first. `/oauth/authorize` is
 * deliberately absent: the consent page needs the owner's login, so it is advertised on the tailnet origin and the
 * owner's browser must be on the tailnet. feat/remote-mcp serves exactly these paths; change both together.
 */
export const FUNNEL_PUBLIC_PATHS = [
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
] as const;

export function isFunnelPublicPath(path: string): boolean {
  return FUNNEL_PUBLIC_PATHS.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Answers a bare 404 to a Funnel request for any path outside the allowlist, before any other handler runs. The
 * header is honored with or without POSTREEVE_TRUST_PROXY: it can only narrow what a request may reach, so trusting
 * it is never less safe, and ignoring it would let a mis-set `tailscale funnel` publish the UI.
 */
export function funnelPathGuard(): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.header(FUNNEL_REQUEST_HEADER) === undefined) return next();
    const path = context.req.path;
    // Bun resolves dot segments before handlers run; encoded characters are refused so no later layer decodes a
    // different path than the one checked here.
    if (/[%\\]/.test(path) || !isFunnelPublicPath(path)) {
      return context.body(null, 404);
    }
    return next();
  };
}
