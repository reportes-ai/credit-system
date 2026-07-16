/* Service worker de AutoFácil Terreno — shell cache-first, API siempre red.
   La app guarda por sí misma el último día cargado en localStorage, así que
   aquí solo cacheamos el cascarón para que abra al instante y funcione
   como app instalada aunque la señal sea mala. */
const CACHE = 'terreno-v2';
const SHELL = ['/terreno/', '/terreno/manifest.json', '/terreno/icon-192.png', '/terreno/icon-512.png', '/img/logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;                    // API: siempre red (la app maneja el fallback)
  if (url.origin !== location.origin) return;                      // CDN (leaflet/tiles): que decida el navegador
  e.respondWith(
    caches.match(e.request).then(hit => {
      const red = fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || red;                                           // cache-first con refresh en segundo plano
    })
  );
});
