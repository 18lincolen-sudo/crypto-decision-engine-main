const CACHE_NAME = 'crypto-decision-engine-v4';
const PRECACHE_URLS = ['/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // ── APIs, the worker backend, and external hosts: NEVER intercept ──────────
  // Previously /api/* and /health failures were masked here with a synthetic
  // 503 Response, which made a connectivity problem (worker asleep, DNS
  // hiccup) look like a server-side "Worker 503" in the dashboard and broke
  // the client's real error handling. Let these requests hit the network
  // directly so failures surface as real network errors.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health' ||
    url.hostname.includes('bybit.com') ||
    url.hostname.includes('binance.com') ||
    url.hostname.includes('coingecko.com') ||
    url.hostname.includes('alternative.me') ||
    url.origin !== self.location.origin
  ) {
    return; // no respondWith — browser handles the request normally
  }

  // ── Web app manifest: network-first WITH a cache fallback ──────────────────
  // Previously this was network-first with NO fallback and no caching, so a
  // transient failure (e.g. a Netlify deploy-protection 401 window) reached
  // the browser unchanged and the manifest stayed broken until the next
  // successful load. Now: cache only OK responses; on a non-OK response or a
  // network failure serve the last good copy (seeded at install).
  if (url.pathname === '/manifest.json') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/manifest.json', copy));
            return response;
          }
          return caches.match('/manifest.json').then((cached) => cached || response);
        })
        .catch(() => caches.match('/manifest.json'))
    );
    return;
  }

  // Navigation requests: Network-first, fallback to /index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match('/index.html');
        return cached || fetch('/index.html');
      })
    );
    return;
  }

  // Network-first for static application assets with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return caches.match('/index.html');
      })
  );
});

