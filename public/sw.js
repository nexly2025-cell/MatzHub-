/* MatzHub service worker — offline shell + product catalogue cache.
   Scope: /  Version bump forces refresh. */
const VERSION = "mh-v1";
const SHELL = ["/", "/offline"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls or authenticated surfaces. /reseller carries
  // per-user margin and order history; caching it would survive logout and
  // could be replayed offline on a shared device.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin") ||
    url.pathname.startsWith("/reseller")
  )
    return;

  // Images & static assets: cache-first
  if (e.request.destination === "image" || /\.(svg|css|woff2|json)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Pages: network-first, fall back to cache, then offline shell
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && e.request.method === "GET") {
          const clone = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match("/offline")))
  );
});
