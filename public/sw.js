// Postreeve service worker: caches the application shell so an installed app opens without the network.
// It never touches /api/, so mail, drafts and account data are never stored here.
const CACHE = "postreeve-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

function isShellRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  // Server-rendered or agent endpoints: the OAuth consent page must never become the cached shell.
  if (/^\/(api|oauth|mcp|\.well-known)(\/|$)/.test(url.pathname)) return false;
  return url.pathname !== "/sw.js";
}

function cacheable(response) {
  return response.status === 200 && response.type === "basic"
    && !/no-store|private/i.test(response.headers.get("Cache-Control") || "");
}

async function remember(key, response) {
  if (cacheable(response)) {
    const cache = await caches.open(CACHE);
    await cache.put(key, response.clone());
  }
  return response;
}

async function networkFirst(request, key) {
  try {
    return await remember(key, await fetch(request));
  } catch (error) {
    const cached = await caches.match(key);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  return cached || remember(request, await fetch(request));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("postreeve-shell-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isShellRequest(request)) return;
  const { pathname } = new URL(request.url);
  // Every route renders the same index.html, so one cached page serves any offline navigation.
  if (request.mode === "navigate") event.respondWith(networkFirst(request, "/"));
  else if (pathname.startsWith("/assets/")) event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request, request));
});
