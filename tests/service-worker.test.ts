import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  request?: { method: string; url: string; mode: string };
  respondWith?: (response: Promise<Response>) => void;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const source = readFileSync("public/sw.js", "utf8");

function loadWorker() {
  const listeners = new Map<string, Listener>();
  const stored: string[] = [];
  const cache = {
    put: async (key: Request | string) => { stored.push(typeof key === "string" ? key : key.url); },
    addAll: async (keys: string[]) => { stored.push(...keys); },
  };
  const caches = {
    open: async () => cache,
    match: async () => undefined,
    keys: async () => [] as string[],
    delete: async () => true,
  };
  const self = {
    location: { origin: "http://127.0.0.1:3000" },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetched: string[] = [];
  let cacheControl = "";
  // A same-origin fetch in a worker yields a "basic" response; Bun's Response constructor cannot.
  const fetch = async (request: { url: string }) => {
    fetched.push(request.url);
    const response = { status: 200, type: "basic", headers: new Headers(cacheControl ? { "Cache-Control": cacheControl } : {}), clone: () => response };
    return response;
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetch);
  function dispatch(method: string, url: string, mode = "cors"): Promise<Response> | null {
    let responded: Promise<Response> | null = null;
    listeners.get("fetch")!({ request: { method, url, mode }, respondWith: (response) => { responded = response; } });
    return responded;
  }
  return { dispatch, stored, fetched, listeners, noStore: () => { cacheControl = "no-store"; } };
}

describe("shell service worker", () => {
  test("never answers or caches API requests", () => {
    const worker = loadWorker();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/api/accounts")).toBeNull();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/api/messages/query?x=1")).toBeNull();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/api")).toBeNull();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/oauth/authorize?client_id=x", "navigate")).toBeNull();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/mcp")).toBeNull();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/.well-known/oauth-authorization-server")).toBeNull();
    expect(worker.stored).toEqual([]);
  });

  test("ignores writes, other origins and itself", () => {
    const worker = loadWorker();
    expect(worker.dispatch("POST", "http://127.0.0.1:3000/")).toBeNull();
    expect(worker.dispatch("GET", "https://fonts.googleapis.com/css2")).toBeNull();
    expect(worker.dispatch("GET", "http://127.0.0.1:3000/sw.js")).toBeNull();
  });

  test("serves navigations network-first and caches them as the shell", async () => {
    const worker = loadWorker();
    const response = worker.dispatch("GET", "http://127.0.0.1:3000/?google=connected", "navigate");
    expect(response).not.toBeNull();
    await response;
    expect(worker.fetched).toEqual(["http://127.0.0.1:3000/?google=connected"]);
    expect(worker.stored).toEqual(["/"]);
  });

  test("does not cache responses marked no-store", async () => {
    const worker = loadWorker();
    worker.noStore();
    await worker.dispatch("GET", "http://127.0.0.1:3000/icons/icon-192.png");
    expect(worker.fetched).toHaveLength(1);
    expect(worker.stored).toEqual([]);
  });

  test("precaches only shell files on install", async () => {
    const worker = loadWorker();
    let installed: Promise<unknown> | undefined;
    worker.listeners.get("install")!({ waitUntil: (promise) => { installed = promise; } });
    await installed;
    expect(worker.stored.every((path) => !path.startsWith("/api"))).toBe(true);
    expect(worker.stored).toContain("/");
  });
});
