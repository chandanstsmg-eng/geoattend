// GeoAttend admin web-push service worker. Shows alerts pushed by the API.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'GeoAttend', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'GeoAttend alert';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.notificationId || undefined,
      requireInteraction: data.severity === 'CRITICAL',
      data: { url: '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
