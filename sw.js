const CACHE = 'future-floor-plans-v9';
const APP_SHELL = ['./', './index.html', './styles.css', './js/app.js', './js/geometry.js', './js/storage.js', './manifest.webmanifest', './assets/icon.svg'];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
const DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const sameOrigin = new URL(event.request.url).origin === location.origin;
  const cachePut = response => { if (sameOrigin && response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); } return response; };
  if (DEV && sameOrigin) {
    // Local development: network-first so code edits appear on reload; cache backs offline.
    event.respondWith(fetch(event.request).then(cachePut).catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html'))));
    return;
  }
  // Production: stale-while-revalidate — serve cache instantly (fast + offline) but
  // always refetch in the background so the NEXT load picks up a new deploy.
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    const network = fetch(event.request).then(cachePut).catch(() => null);
    return cached || (await network) || caches.match('./index.html');
  })());
});
