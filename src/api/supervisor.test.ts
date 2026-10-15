import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchSupervisorCapabilities, runSupervisorAction } from './supervisor.ts';
import type { SipConfig } from '../types.ts';

const config = {
  extension: '550', password: 'sip-secret', sipDomain: 'tenant.example', sipServer: 'connect.skyetel.ai',
} as SipConfig;

test('supervisor capabilities use extension-bound Basic authentication', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  let authorization = '';
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get('Authorization') || '';
    return new Response(JSON.stringify({ enabled: true, full_control: true, can_spy: true, can_whisper: true, can_barge: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const capabilities = await fetchSupervisorCapabilities(config);
    assert.equal(url, 'https://skyevox.skyetel.ai/api/connect/supervisor/550/capabilities');
    assert.equal(atob(authorization.slice('Basic '.length)), '550@tenant.example:sip-secret');
    assert.equal(capabilities.full_control, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('supervisor actions carry only the selected call action and destination', async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    request = init;
    return new Response(JSON.stringify({ ok: true, message: 'Action completed' }), { status: 200 });
  }) as typeof fetch;
  try {
    await runSupervisorAction(config, 'call-uuid', 'transfer', '551');
    assert.equal(request?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request?.body)), { uuid: 'call-uuid', action: 'transfer', destination: '551' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
