/* SkyeVox Connect incoming-call Web Push worker. */
self.addEventListener('push', event => {
  let call = {};
  try { call = event.data ? event.data.json() : {}; } catch { call = {}; }
  if (call.type !== 'incoming-call') return;
  const caller = call.caller_name || call.caller_id || 'Unknown caller';
  event.waitUntil(self.registration.showNotification('Incoming SkyeVox call', {
    body: String(caller),
    tag: `skyevox-call-${call.extension || 'line'}`,
    renotify: true,
    requireInteraction: true,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: call,
    actions: [
      { action: 'answer', title: 'Open phone' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  }));
});

self.addEventListener('notificationclick', event => {
  const call = event.notification.data || {};
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin !== self.location.origin || !['/', '/portal', '/connect/index.html'].includes(current.pathname)) continue;
      client.postMessage({ type: 'skyevox-push-open', call });
      await client.focus();
      return;
    }
    const extensionId = Number(call.extension_id || 0);
    const url = `/connect/index.html?embedded=1${extensionId > 0 ? `&extension_id=${extensionId}` : ''}`;
    await clients.openWindow(url);
  })());
});
