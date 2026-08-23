const CACHE_NAME = 'crypto-decision-engine-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
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

  // Always use network for APIs, Bybit, CoinGecko and navigation.
  if (
    url.pathname.startsWith('/api/') ||
    url.origin !== self.location.origin ||
    url.hostname.includes('bybit.com') ||
    url.hostname.includes('coingecko.com') ||
    event.request.mode === 'navigate'
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for application assets.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || Response.error())
  );
});
