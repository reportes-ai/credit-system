/* Service worker de "¿Dónde curso?" — cascarón cache-first, API siempre a la red.

   Se cachean también los motores de cálculo (rentabilidad, tier UAC, preferencia)
   porque sin ellos la app no puede responder nada. Los parámetros del negocio los
   guarda la app en localStorage, así que en el patio sin señal igual calcula, con
   los últimos valores conocidos y avisando que son de antes. */
const CACHE = 'donde-curso-v2';   // v2: íconos propios
const SHELL = [
  '/donde-curso/', '/donde-curso/manifest.json',
  '/donde-curso/icon-192.png', '/donde-curso/icon-512.png',
  '/js/comision-dealer.js', '/js/rentabilidad-core.js', '/js/rentabilidad-calc.js',
  '/js/uac-tier.js', '/js/preferencia-financiera.js',
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
  if (url.pathname.startsWith('/api/')) return;   // API: siempre red (la app maneja el fallback)
  if (url.origin !== location.origin) return;     // CDN de íconos: que decida el navegador
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
