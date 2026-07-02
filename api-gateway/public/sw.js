/* Service Worker mínimo de AutoFácil.
   Su ÚNICO propósito es habilitar la instalación como PWA (app de escritorio).
   NO cachea nada: la app se despliega seguido (Render) y un caché serviría
   versiones viejas del código. Todo pasa directo a la red. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Fetch passthrough (sin respondWith → va a la red normal). Requerido para instalabilidad.
self.addEventListener('fetch', () => { /* red directa, sin caché */ });
