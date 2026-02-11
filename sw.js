const BASE = "/colectas-pwa";
const CACHE_NAME = "colectas-pwa-v1";

const ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/app.js`,
  `${BASE}/manifest.json`
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (req.method === "GET" && res && res.status === 200) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      const fallback = await cache.match(`${BASE}/index.html`);
      return fallback || new Response("Offline", { status: 503 });
    }
  })());
});
