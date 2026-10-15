import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchDndState, updateDndState } from './dnd.ts';
import type { SipConfig } from '../types.ts';

const config = {
  extension: '799', password: 'sip-secret', sipDomain: 'tenant.example', sipServer: 'connect.skyetel.ai',
} as SipConfig;

test('standalone DND uses the Green API with extension-bound authentication', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ extension: '799', enabled: init?.method === 'POST' }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await fetchDndState(config), false);
    assert.equal(await updateDndState(config, true), true);
    assert.equal(requests[0].url, 'https://skyevox.skyetel.ai/api/connect/dnd/799');
    assert.equal(atob(new Headers(requests[0].init?.headers).get('Authorization')!.slice('Basic '.length)), '799@tenant.example:sip-secret');
    assert.equal(requests[1].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { enabled: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DND update rejects an HTTP failure instead of displaying a false success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(updateDndState(config, true), /DND state update failed: 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
