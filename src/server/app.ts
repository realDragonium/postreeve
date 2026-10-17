import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createAgentAccess, type AgentAccessOptions } from "./agent-access";
import { createApi, type ApiOptions } from "./api";
import type { PostreeveService } from "./core/postreeve";
import type { GoogleOAuth } from "./google/oauth";
import { desktopApiAuthentication } from "./security/desktop-auth";
import { postreeveSecureHeaders } from "./security/headers";
import { createAuthApi, ownerApiGuard, ownerAuthContext, type OwnerAuth } from "./security/owner-auth";
import { allowedHostGuard, sameOriginGuard } from "./security/request-origin";

export interface ServerAppOptions {
  readonly service: PostreeveService;
  readonly auth: OwnerAuth;
  readonly hostname: string;
  readonly googleOAuth?: GoogleOAuth | undefined;
  readonly desktopToken?: string | undefined;
  readonly api?: ApiOptions;
  /** Remote MCP and OAuth routes; omitted in tests that do not cover agent access. */
  readonly agentAccess?: AgentAccessOptions;
  /** Directory of the built web interface; omitted in API-only tests. */
  readonly staticRoot?: string;
}

/** The server's middleware order in one place, shared by production and contract tests. */
export function createServerApp(options: ServerAppOptions): Hono {
  const { auth } = options;
  const app = new Hono();
  app.use("*", postreeveSecureHeaders);
  app.use("*", allowedHostGuard(options.hostname, auth.trust));
  app.use("*", ownerAuthContext(auth));
  if (options.desktopToken?.trim()) {
    // The desktop token authenticates every API call, and the protocol proxy forwards a postreeve:// Origin.
    app.use("/api/*", desktopApiAuthentication(options.desktopToken));
  } else {
    app.use("/api/*", sameOriginGuard(auth.trust));
    app.use("/api/*", ownerApiGuard);
  }
  app.route("/", createAuthApi(auth));
  app.route("/", createApi(options.service, options.googleOAuth, {
    ...options.api,
    stillAuthorized: (context) => auth.sessionStillActive(context),
  }));
  if (options.agentAccess) app.route("/", createAgentAccess(options.agentAccess));
  if (options.staticRoot) {
    app.use("/*", serveStatic({ root: options.staticRoot }));
    app.get("/*", serveStatic({ path: `${options.staticRoot}/index.html` }));
  }
  return app;
}
