const CACHE_NAME = "colectas-pwa-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "https://cdn.tailwindcss.com"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async ()=>{
      const keys = await caches.keys();
      await Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  event.respondWith(
    (async ()=>{
      const cached = await caches.match(req);
      if(cached) return cached;
      try{
        const res = await fetch(req);
        // Cachea GET exitosos
        if(req.method === "GET" && res.status === 200){
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone()).catch(()=>{});
        }
        return res;
      } catch {
        // fallback básico
        return cached || new Response("Offline", { status: 503 });
      }
    })()
  );
});
