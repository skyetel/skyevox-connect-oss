import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

interface NotificationRecord {
  title: string;
  options: Record<string, unknown>;
}
function loadWorker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const notifications: NotificationRecord[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://skyevox.skyetel.ai' },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { notifications.push({ title, options }); } },
    addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
  };
  const clients = { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); return null; } };
  vm.runInNewContext(readFileSync(new URL('../../public/connect-sw.js', import.meta.url), 'utf8'), { self, clients, URL });
  return { handlers, notifications, opened };
}

test('push displays a persistent incoming-call notification', async () => {
  const worker = loadWorker();
  let pending: Promise<unknown> = Promise.resolve();
  worker.handlers.get('push')!({
    data: { json: () => ({ type: 'incoming-call', extension: '550', caller_name: 'Customer' }) },
    waitUntil: (promise: Promise<unknown>) => { pending = promise; },
  });
  await pending;
  assert.equal(worker.notifications[0].title, 'Incoming SkyeVox call');
  assert.equal(worker.notifications[0].options.body, 'Customer');
  assert.equal(worker.notifications[0].options.requireInteraction, true);
});

test('notification click opens the authorized Connect extension', async () => {
  const worker = loadWorker();
  let pending: Promise<unknown> = Promise.resolve();
  worker.handlers.get('notificationclick')!({
    action: 'answer',
    notification: { data: { reservation_id: 'r1', extension_id: 42 }, close() {} },
    waitUntil: (promise: Promise<unknown>) => { pending = promise; },
  });
  await pending;
  assert.deepEqual(worker.opened, ['/connect/index.html?embedded=1&extension_id=42']);
});
