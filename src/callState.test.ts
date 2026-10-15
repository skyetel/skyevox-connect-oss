import assert from 'node:assert/strict';
import test from 'node:test';

import { usesActiveCallControls } from './callState.ts';

test('inbound ringing is reserved for incoming Answer controls', () => {
  assert.equal(usesActiveCallControls('ringing'), false);
});

test('outbound and established states retain active call controls', () => {
  assert.equal(usesActiveCallControls('dialing'), true);
  assert.equal(usesActiveCallControls('active'), true);
  assert.equal(usesActiveCallControls('held'), true);
  assert.equal(usesActiveCallControls('idle'), false);
});
