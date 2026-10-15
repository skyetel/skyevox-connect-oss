import assert from 'node:assert/strict';
import test from 'node:test';

import { API_BASE, DEFAULT_PARK_CODE, normalizeSipConfig, normalizeSipHost, sipConfigFromProvisioning, SKYETEL_CONNECT_HOST } from './config.ts';

test('working HTTPS API origin remains separate from canonical SIP signaling host', () => {
  assert.equal(API_BASE, 'https://connect.skyetel.money');
  assert.equal(SKYETEL_CONNECT_HOST, 'connect.skyetel.ai');
  assert.equal(normalizeSipHost('connect.skyetel.money'), SKYETEL_CONNECT_HOST);
});

test('provisioning does not expose a codec policy the client cannot enforce', () => {
  const payload = {
    sip_server: 'connect.skyetel.ai',
    codecs: ['unsupported-codec'],
  } as Parameters<typeof sipConfigFromProvisioning>[0];
  const config = sipConfigFromProvisioning(payload);
  assert.equal('codecs' in config, false);
});

test('provisioning hands the push register expiry to the native engine alongside register_interval', () => {
  const config = sipConfigFromProvisioning({
    sip_server: 'connect.skyetel.ai',
    register_interval: 120,
    mobile: {
      engine: 'liblinphone',
      pushEnabled: true,
      pushRegisterExpiresSeconds: 86400,
      defaultCallingEligible: false,
      smsEnabled: true,
      mmsEnabled: true,
      e911Enabled: true,
    },
  });
  assert.equal(config.registerInterval, 120);
  assert.equal(config.mobile?.pushRegisterExpiresSeconds, 86400);
});

test('desktop provisioning preserves the configured call-park feature code', () => {
  const config = sipConfigFromProvisioning({
    sip_server: 'connect.skyetel.ai',
    park_code: '*5900',
  });
  assert.equal(config.parkCode, '*5900');
});

test('legacy desktop configuration receives the current default call-park code', () => {
  const config = normalizeSipConfig({
    sipDomain: 'tenant.example',
    sipServer: 'connect.skyetel.ai',
    wssUrl: 'wss://connect.skyetel.ai:8443',
    username: '799',
    password: 'secret',
    displayName: '799',
    extension: '799',
    turnServer: 'turn:connect.skyetel.ai:3478',
    turnCredentials: { username: '', credential: '' },
    srtp: 'opportunistic',
    registerInterval: 300,
  });
  assert.equal(config.parkCode, DEFAULT_PARK_CODE);
});

test('saved display-name extension recovers the numeric SIP identity without changing its display name', () => {
  const saved = sipConfigFromProvisioning({
    username: 'sip:310@tenant.example',
    extension: 'Brooke Glenn',
    display_name: 'Brooke Glenn',
  });
  assert.equal(saved.extension, '310');
  assert.equal(saved.username, '310');
  assert.equal(saved.displayName, 'Brooke Glenn');
  assert.equal(normalizeSipConfig(saved).extension, '310');
});

test('extension repair preserves valid distinct identifiers and never guesses from a display name', () => {
  const distinct = sipConfigFromProvisioning({ username: '999', extension: '0310' });
  assert.equal(distinct.extension, '0310');
  assert.equal(distinct.username, '999');
  const unknown = sipConfigFromProvisioning({ username: 'sip-account', extension: 'Brooke Glenn' });
  assert.equal(unknown.extension, 'Brooke Glenn');
});
