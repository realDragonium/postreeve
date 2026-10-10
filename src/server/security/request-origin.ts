import type { MiddlewareHandler } from "hono";

const loopbackHostnames = ["127.0.0.1", "localhost", "[::1]"];
const wildcardHostnames = new Set(["0.0.0.0", "[::]"]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function allowedHostGuard(configuredHostname: string): MiddlewareHandler {
  const bracketed = bracketIpv6(configuredHostname.trim());
  const configured = hostnameOf(bracketed) ?? bracketed.toLowerCase();
  const allowed = new Set(loopbackHostnames);
  if (!wildcardHostnames.has(configured)) allowed.add(configured);

  return async (context, next) => {
    const hostname = hostnameOf(context.req.header("Host"));
    if (!hostname || !allowed.has(hostname)) {
      return context.json({ error: "Forbidden host" }, 403);
    }
    return next();
  };
}

export function sameOriginGuard(): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("Origin");
    if (origin !== undefined && !safeMethods.has(context.req.method)
      && origin.toLowerCase() !== `http://${context.req.header("Host")?.toLowerCase()}`) {
      return context.json({ error: "Forbidden origin" }, 403);
    }
    return next();
  };
}

function bracketIpv6(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
