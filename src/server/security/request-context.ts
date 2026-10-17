import type { Context } from "hono";

/** How far the server trusts the network in front of it. */
export interface RequestTrust {
  /** `POSTREEVE_PUBLIC_URL` origin, e.g. `https://postreeve.fly.dev`. */
  readonly publicUrl: URL | null;
  /** `POSTREEVE_TRUST_PROXY`: `X-Forwarded-Proto`, `-Host` and `-For` are believed only when set. */
  readonly trustProxy: boolean;
}

export const untrustedNetwork: RequestTrust = { publicUrl: null, trustProxy: false };

export function parsePublicUrl(value: string | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("POSTREEVE_PUBLIC_URL must be an absolute http or https URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("POSTREEVE_PUBLIC_URL must use http or https");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("POSTREEVE_PUBLIC_URL must be an origin without path, query or credentials");
  }
  return url;
}

export function parseTrustProxy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The value the nearest proxy set: the rightmost entry of a comma-separated forwarding header. A reverse proxy such
 * as `tailscale serve` replaces or appends these headers, so earlier entries may come from the client.
 */
export function forwardedHeader(context: Context, trust: RequestTrust, name: string): string | undefined {
  if (!trust.trustProxy) return undefined;
  const value = context.req.header(name)?.split(",").at(-1)?.trim();
  return value || undefined;
}

export function requestScheme(context: Context, trust: RequestTrust): "http" | "https" {
  const forwarded = forwardedHeader(context, trust, "X-Forwarded-Proto")?.toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return new URL(context.req.url).protocol === "https:" ? "https" : "http";
}

/** The host the browser addressed: `X-Forwarded-Host` from a trusted proxy, else `Host`. */
export function requestHost(context: Context, trust: RequestTrust): string | undefined {
  return (forwardedHeader(context, trust, "X-Forwarded-Host") ?? context.req.header("Host"))?.toLowerCase();
}

export function targetsPublicUrl(context: Context, trust: RequestTrust): boolean {
  return trust.publicUrl !== null && hostnameOf(requestHost(context, trust)) === trust.publicUrl.hostname;
}

/** Origins a same-origin page on this request's host may send. */
export function expectedOrigins(context: Context, trust: RequestTrust): Set<string> {
  const origins = new Set<string>();
  const host = requestHost(context, trust);
  if (host) origins.add(`${requestScheme(context, trust)}://${host}`);
  if (targetsPublicUrl(context, trust)) origins.add(trust.publicUrl!.origin);
  return origins;
}

export function isSecureRequest(context: Context, trust: RequestTrust): boolean {
  if (requestScheme(context, trust) === "https") return true;
  return targetsPublicUrl(context, trust) && trust.publicUrl!.protocol === "https:";
}

interface SocketAddressServer {
  requestIP?: (request: Request) => { address: string } | null;
}

/** Identifies the client for rate limiting. Tailscale identity headers are never used: anything reaching the port can send them. */
export function clientKey(context: Context, trust: RequestTrust): string {
  const forwarded = forwardedHeader(context, trust, "X-Forwarded-For");
  if (forwarded) return forwarded;
  const server = context.env as SocketAddressServer | undefined;
  try {
    return server?.requestIP?.(context.req.raw)?.address ?? "local";
  } catch {
    return "local";
  }
}

export interface RelyingParty {
  readonly id: string;
  readonly origin: string;
}

/** WebAuthn needs a domain name in a secure context: the public URL, or localhost for development. */
export function relyingParty(context: Context, trust: RequestTrust): RelyingParty | null {
  if (targetsPublicUrl(context, trust)) return { id: trust.publicUrl!.hostname, origin: trust.publicUrl!.origin };
  const host = requestHost(context, trust);
  if (hostnameOf(host) === "localhost") return { id: "localhost", origin: `${requestScheme(context, trust)}://${host}` };
  return null;
}
