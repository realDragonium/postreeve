import type { MiddlewareHandler } from "hono";
import { expectedOrigins, forwardedHeader, hostnameOf, untrustedNetwork, type RequestTrust } from "./request-context";

const loopbackHostnames = ["127.0.0.1", "localhost", "[::1]"];
const wildcardHostnames = new Set(["0.0.0.0", "[::]"]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const crossSiteFetches = new Set(["cross-site", "same-site"]);

export function allowedHostGuard(configuredHostname: string, trust: RequestTrust = untrustedNetwork): MiddlewareHandler {
  const bracketed = bracketIpv6(configuredHostname.trim());
  const configured = hostnameOf(bracketed) ?? bracketed.toLowerCase();
  const allowed = new Set(loopbackHostnames);
  if (!wildcardHostnames.has(configured)) allowed.add(configured);
  if (trust.publicUrl) allowed.add(trust.publicUrl.hostname);

  return async (context, next) => {
    // Both names must be allowed: a rebinding page can add X-Forwarded-Host but cannot change Host.
    const hostname = hostnameOf(context.req.header("Host"));
    const forwarded = forwardedHeader(context, trust, "X-Forwarded-Host");
    if (!hostname || !allowed.has(hostname) || (forwarded !== undefined && !allowed.has(hostnameOf(forwarded) ?? ""))) {
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
