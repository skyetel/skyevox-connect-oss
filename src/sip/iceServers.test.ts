import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRuntimeIceServers, resolveIceServers } from './iceServers.ts';

test('production ICE array preserves valid STUN and TURN URL semantics', () => {
  const servers = normalizeRuntimeIceServers([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:connect.skyetel.ai:3478?transport=udp', username: 'turn-user', credential: 'turn-secret' },
    { urls: 'turns:connect.skyetel.ai:443?transport=tcp', username: 'turn-user', credential: 'turn-secret' },
  ]);
  assert.deepEqual(servers, [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:connect.skyetel.ai:3478?transport=udp', username: 'turn-user', credential: 'turn-secret' },
    { urls: 'turns:connect.skyetel.ai:443?transport=tcp', username: 'turn-user', credential: 'turn-secret' },
  ]);
  assert.equal(servers.some((server) => String(server.urls).includes('stun:connect.skyetel.ai:3478?transport=udp')), false);
});

test('legacy TURN fallback removes transport query from synthesized STUN URL', () => {
  const servers = resolveIceServers({
    iceServers: undefined,
    turnServer: 'turn:connect.skyetel.ai:3478?transport=udp',
    turnCredentials: { username: 'turn-user', credential: 'turn-secret' },
  });
  assert.deepEqual(servers, [
    { urls: 'stun:connect.skyetel.ai:3478' },
    { urls: 'turn:connect.skyetel.ai:3478?transport=udp', username: 'turn-user', credential: 'turn-secret' },
  ]);
});

test('malformed and unsupported ICE URLs are discarded', () => {
  assert.deepEqual(normalizeRuntimeIceServers([
    { urls: 'https://not-an-ice-server.example' },
    { urls: 'stun:bad host.example' },
    { missing: 'urls' },
  ]), []);
});
