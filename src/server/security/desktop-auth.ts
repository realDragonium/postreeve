import type { MiddlewareHandler } from "hono";

const googleOAuthCallbackPath = "/api/oauth/google/callback";

export function desktopApiAuthentication(token: string | undefined): MiddlewareHandler {
  const expectedAuthorization = token?.trim() ? `Bearer ${token.trim()}` : undefined;

  return async (context, next) => {
    if (!expectedAuthorization || context.req.path === googleOAuthCallbackPath) {
      return next();
    }
    if (context.req.header("Authorization") !== expectedAuthorization) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };
}
