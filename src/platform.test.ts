import assert from 'node:assert/strict';
import test from 'node:test';

import { platformUsesLocalRingtone, platformUsesNativeEngine } from './nativeEnginePolicy.ts';

test('native liblinphone engine is used only by the implemented Android and iOS bridges', () => {
  assert.equal(platformUsesNativeEngine('android', 'liblinphone'), true);
  assert.equal(platformUsesNativeEngine('ios', 'liblinphone'), true);
  assert.equal(platformUsesNativeEngine('web', 'liblinphone'), false);
  assert.equal(platformUsesNativeEngine('electron', 'liblinphone'), false);
  assert.equal(platformUsesNativeEngine('android', 'sipjs'), false);
  assert.equal(platformUsesNativeEngine('ios', 'sipjs'), false);
  assert.equal(platformUsesNativeEngine('android', 'pjsip'), false);
  assert.equal(platformUsesNativeEngine('android'), false);
  assert.equal(platformUsesNativeEngine('ios'), false);
});

test('every SIP.js engine owns local ringtone audio, including native shells', () => {
  assert.equal(platformUsesLocalRingtone('android', 'sipjs'), true);
  assert.equal(platformUsesLocalRingtone('ios', 'sipjs'), true);
  assert.equal(platformUsesLocalRingtone('web', 'sipjs'), true);
  assert.equal(platformUsesLocalRingtone('electron', 'sipjs'), true);
  assert.equal(platformUsesLocalRingtone('android', 'liblinphone'), false);
  assert.equal(platformUsesLocalRingtone('ios', 'liblinphone'), false);
});
