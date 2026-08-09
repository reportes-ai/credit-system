/* Service worker de "Clave Gerencia" — cascarón cache-first, API siempre a la red.
   Generar un código EXIGE conexión (el código nace en el servidor); el cascarón
   en caché solo garantiza que la app abra al tiro desde el teléfono. */
const CACHE = 'clave-gerencia-v1';
const SHELL = [
  '/clave-gerencia/', '/clave-gerencia/manifest.json',
  '/clave-gerencia/icon-192.png', '/clave-gerencia/icon-512.png',
  '/img/logo.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;   // API: siempre red
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      const red = fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || red;                          // cache-first con refresco en segundo plano
    })
  );
});
