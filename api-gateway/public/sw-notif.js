/* Service worker de notificaciones push — AutoFácil */
'use strict';

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.titulo || 'AutoFácil', {
    body: d.mensaje || '',
    icon: '/img/favicon.png',
    badge: '/img/favicon.png',
    data: { href: d.href || '/' },
    vibrate: [200, 100, 200],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const href = (e.notification.data && e.notification.data.href) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(href.split('?')[0]) && 'focus' in w) return w.focus();
      }
      return clients.openWindow(href);
    })
  );
});
