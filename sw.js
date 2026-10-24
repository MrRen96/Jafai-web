"use strict";

const CACHE_NAME = "jafai-shell-v1";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/jafai-logo.png", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("jafai-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only public shell assets: never intercept chat requests or knowledge files.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !APP_SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      // Network first so new deployments are visible without stale cached code.
      const response = await fetch(event.request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy)).catch(() => {}));
      }
      return response;
    } catch (error) {
      const cached = await caches.match(url.pathname, { cacheName: CACHE_NAME });
      if (cached) return cached;
      throw error;
    }
  })());
});
