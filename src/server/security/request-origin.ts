import type { MiddlewareHandler } from "hono";
import { expectedOrigins, hostnameOf, untrustedNetwork, type RequestTrust } from "./request-context";

const loopbackHostnames = ["127.0.0.1", "localhost", "[::1]"];
const wildcardHostnames = new Set(["0.0.0.0", "[::]"]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const crossSiteFetches = new Set(["cross-site", "same-site"]);

export function allowedHostGuard(configuredHostname: string, publicUrl: URL | null = null): MiddlewareHandler {
  const bracketed = bracketIpv6(configuredHostname.trim());
  const configured = hostnameOf(bracketed) ?? bracketed.toLowerCase();
  const allowed = new Set(loopbackHostnames);
  if (!wildcardHostnames.has(configured)) allowed.add(configured);
  if (publicUrl) allowed.add(publicUrl.hostname);

  return async (context, next) => {
    const hostname = hostnameOf(context.req.header("Host"));
    if (!hostname || !allowed.has(hostname)) {
      return context.json({ error: "Forbidden host" }, 403);
    }
    return next();
  };
}

/** Rejects cross-site writes so a session cookie alone never authorizes one. */
export function sameOriginGuard(trust: RequestTrust = untrustedNetwork): MiddlewareHandler {
  return async (context, next) => {
    if (safeMethods.has(context.req.method)) return next();
    const origin = context.req.header("Origin");
    const fetchSite = context.req.header("Sec-Fetch-Site")?.toLowerCase();
    const forbidden = origin !== undefined
      ? !expectedOrigins(context, trust).has(origin.toLowerCase())
      : fetchSite !== undefined && crossSiteFetches.has(fetchSite);
    if (forbidden) return context.json({ error: "Forbidden origin" }, 403);
    return next();
  };
}

function bracketIpv6(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}
