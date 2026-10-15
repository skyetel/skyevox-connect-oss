import assert from 'node:assert/strict';
import test from 'node:test';
import { isEmbeddedWebPhone, loadEmbeddedSipConfig, normalizeEmbeddedWebSocketURL, resolveEmbeddedRequestURL } from './embedded.ts';

test('embedded web phone uses the selected session extension and runtime transport', async () => {
  const paths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    if (path === '/api/softphone/config') {
      return new Response(JSON.stringify({
        wss_url: 'wss://connect.skyetel.ai:7443',
        register_interval: 120,
        park_code: '*5900',
        ice_servers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'turn:connect.skyetel.ai:3478?transport=udp', username: 'turn-user', credential: 'turn-secret' },
          { urls: 'turns:connect.skyetel.ai:443?transport=tcp', username: 'turn-user', credential: 'turn-secret' },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      extension: '550', password: 'sip-secret', domain_name: 'tenant.example', display_name: 'Operator', sms_number: '+15550000550',
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const config = await loadEmbeddedSipConfig('?embedded=1&extension_id=42');
    assert.deepEqual(paths, ['/api/softphone/config', '/api/softphone/credentials/42']);
    assert.equal(config.embedded, true);
    assert.equal(config.extension, '550');
    assert.equal(config.sipDomain, 'tenant.example');
    assert.equal(config.wssUrl, 'wss://connect.skyetel.ai:7443');
    assert.equal(config.parkCode, '*5900');
    assert.equal(config.smsFrom, '+15550000550');
    assert.equal(config.turnCredentials.username, 'turn-user');
    assert.deepEqual(config.iceServers, [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:connect.skyetel.ai:3478?transport=udp', username: 'turn-user', credential: 'turn-secret' },
      { urls: 'turns:connect.skyetel.ai:443?transport=tcp', username: 'turn-user', credential: 'turn-secret' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedded mode requires an explicit embedded flag', () => {
  assert.equal(isEmbeddedWebPhone('?embedded=1'), true);
  assert.equal(isEmbeddedWebPhone('?embedded=0'), false);
});

test('srcdoc phone resolves session API requests against its parent origin', () => {
  const resolved = resolveEmbeddedRequestURL('/api/softphone/config', 'about:srcdoc', 'https://skyevox.skyetel.ai');
  assert.equal(resolved.toString(), 'https://skyevox.skyetel.ai/api/softphone/config');
});

test('relative WebSocket routes become same-origin secure transports', () => {
  assert.equal(
    normalizeEmbeddedWebSocketURL('/ws', 'https://skyevox.skyetel.ai'),
    'wss://skyevox.skyetel.ai/ws',
  );
  assert.equal(
    normalizeEmbeddedWebSocketURL(undefined, 'https://skyevox.skyetel.ai'),
    'wss://skyevox.skyetel.ai/ws',
  );
});
