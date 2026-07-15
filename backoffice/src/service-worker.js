// Minimal hand-written service worker — only handles web-push. Served at site root (not
// under /assets/) because a push subscription's scope must cover the whole app. No
// @angular/service-worker / asset caching involved on purpose.

// Activate a new version immediately instead of waiting for every tab on the old one to
// close — there's no cached content here to worry about invalidating mid-session.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload (e.g. a manual test push) — fall back to the default title/body below
    // rather than crashing the handler.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Lattice', {
      body: data.body,
      data: data.data,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
