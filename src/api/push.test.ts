import assert from 'node:assert/strict';
import test from 'node:test';
import { claimPendingBrowserCalls, disableBrowserPush, enableBrowserPush } from './push.ts';
import type { SipConfig } from '../types.ts';

const config: SipConfig = {
  sipDomain: 'tenant.example', sipServer: 'connect.skyetel.ai', wssUrl: 'wss://connect.skyetel.ai/ws',
  username: '550', password: 'secret', displayName: 'Operator', extension: '550',
  turnServer: '', turnCredentials: { username: '', credential: '' }, srtp: 'optional', registerInterval: 120,
  embedded: true, extensionId: 42,
};

test('pending browser calls are claimed through tenant-scoped same-origin routes', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || 'GET' });
    if (url.includes('/reservations?')) {
      return new Response(JSON.stringify([{ id: 'reservation-1' }]), { status: 200 });
    }
    return new Response(JSON.stringify({ claimed: true }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await claimPendingBrowserCalls(config), 1);
    assert.deepEqual(calls, [
      { url: '/api/connect/push/reservations?extension=550&tenant=tenant.example', method: 'GET' },
      { url: '/api/connect/push/reservations/reservation-1/claim?extension=550&tenant=tenant.example', method: 'POST' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('push enrollment requires the authorized extension id', async () => {
  await assert.rejects(enableBrowserPush({ ...config, extensionId: undefined }), /session extension is required/i);
});

test('phone sign-out removes the local push subscription even if server cleanup fails', async () => {
  const originalFetch = globalThis.fetch;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let unsubscribed = false;
  let requestUrl = '';
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test',
    unsubscribe: async () => {
      unsubscribed = true;
      return true;
    },
  };
  // DOM library shapes are irrelevant here; this test exercises only getSubscription().
  const mockRegistration = {
    pushManager: { getSubscription: async () => subscription },
  } as unknown as ServiceWorkerRegistration;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { register: async () => mockRegistration } },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { PushManager: function PushManager() {} },
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestUrl = String(input);
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(disableBrowserPush(config), /remove background call alerts/i);
    assert.equal(unsubscribed, true);
    assert.equal(requestUrl, '/api/connect/push/subscription?tenant=tenant.example');
  } finally {
    globalThis.fetch = originalFetch;
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
