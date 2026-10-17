/**
 * PLACEHOLDER — replace at merge with the owner-auth workstream (`feat/owner-auth`).
 *
 * It implements only the contract that remote MCP relies on: `getOwnerSession(c)` returns the
 * signed-in owner's session or null, and `requireOwner` answers 401 without one. Until real login
 * exists, the owner is whoever reaches the server through a loopback host name, which is the trust
 * model Postreeve already has. Any other host gets no session, so a hosted deployment that still
 * carries this file fails closed: no consent page and no Connected agents API.
 */
import type { Context, MiddlewareHandler } from "hono";

export interface OwnerSession {
  readonly id: string;
}

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function getOwnerSession(c: Context): OwnerSession | null {
  const host = c.req.header("Host");
  if (!host) return null;
  try {
    return loopbackHostnames.has(new URL(`http://${host}`).hostname.toLowerCase()) ? { id: "loopback-owner" } : null;
  } catch {
    return null;
  }
}

export const requireOwner: MiddlewareHandler = async (c, next) => {
  if (!getOwnerSession(c)) return c.json({ error: "Sign in to Postreeve first" }, 401);
  return next();
};
