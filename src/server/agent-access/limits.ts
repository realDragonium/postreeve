import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Fixed-window request counters for the internet-facing agent endpoints. One process serves
 * one owner, so in-memory counters suffice; a restart only resets them.
 */
export class RateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Counts one request; returns seconds to wait when over the limit, otherwise null. */
  take(key: string, limit: number, windowMs: number): number | null {
    const now = this.#now();
    if (this.#windows.size > 10_000) for (const [entry, value] of this.#windows) if (value.resetAt <= now) this.#windows.delete(entry);
    const window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + windowMs });
      return null;
    }
    window.count += 1;
    return window.count > limit ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : null;
  }
}

/** Behind one trusted proxy, the last forwarded entry is the one the proxy added; the first can be forged. */
export function clientAddress(c: Context): string {
  const forwarded = c.req.header("X-Forwarded-For")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return forwarded?.at(-1) ?? "direct";
}

export function rateLimited(c: Context, retryAfter: number) {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: "rate_limited" }, 429);
}

export function limitByAddress(limiter: RateLimiter, name: string, limit: number, windowMs: number): MiddlewareHandler {
  return async (c, next) => {
    const wait = limiter.take(`${name}:${clientAddress(c)}`, limit, windowMs);
    return wait === null ? next() : rateLimited(c, wait);
  };
}

export function limitBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: "payload_too_large" }, 413) });
}
