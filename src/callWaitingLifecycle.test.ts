import assert from 'node:assert/strict';
import test from 'node:test';

import { CallWaitingLifecycle, type ManagedCall } from './callWaitingLifecycle.ts';

const primary: ManagedCall = {
  sessionId: 'call-a',
  remoteNumber: '101',
  remoteName: 'Caller A',
  direction: 'inbound',
  duration: 42,
};
const waiting: ManagedCall = {
  sessionId: 'call-b',
  remoteNumber: '102',
  remoteName: 'Caller B',
  direction: 'inbound',
  duration: 0,
};

test('accepted waiting call restores primary identity and duration when it ends', () => {
  const lifecycle = new CallWaitingLifecycle();
  lifecycle.setPrimary(primary);
  lifecycle.setWaiting(waiting);

  lifecycle.updatePrimaryDuration(57);
  assert.deepEqual(lifecycle.established('call-b'), {
    kind: 'second',
    call: waiting,
    primary: { ...primary, duration: 57 },
  });
  assert.deepEqual(lifecycle.ended('call-b'), {
    kind: 'restore-primary',
    ended: waiting,
    primary: { ...primary, duration: 57 },
  });
});

test('primary cancellation promotes a still-ringing waiting call', () => {
  const lifecycle = new CallWaitingLifecycle();
  lifecycle.setPrimary({ ...primary, duration: 0 });
  lifecycle.setWaiting(waiting);

  assert.deepEqual(lifecycle.ended('call-a'), {
    kind: 'promote-waiting',
    ended: { ...primary, duration: 0 },
    promoted: waiting,
  });
  assert.deepEqual(lifecycle.established('call-b'), {
    kind: 'primary',
    call: waiting,
  });
});

test('external second-call establishment is recognized until its terminal event', () => {
  const lifecycle = new CallWaitingLifecycle();
  lifecycle.setPrimary(primary);
  lifecycle.setWaiting(waiting);

  assert.equal(lifecycle.established('call-b').kind, 'second');
  assert.equal(lifecycle.ended('call-a').kind, 'primary-ended-under-second');
  assert.deepEqual(lifecycle.ended('call-b'), {
    kind: 'second-ended',
    ended: waiting,
  });
});

test('ending an unanswered waiting call leaves the primary call intact', () => {
  const lifecycle = new CallWaitingLifecycle();
  lifecycle.setPrimary(primary);
  lifecycle.setWaiting(waiting);

  assert.deepEqual(lifecycle.ended('call-b'), {
    kind: 'waiting-ended',
    ended: waiting,
    primary,
  });
  assert.deepEqual(lifecycle.established('call-a'), {
    kind: 'primary',
    call: primary,
  });
});

test('an ended outbound conference leg restores the still-connected original call', () => {
  const lifecycle = new CallWaitingLifecycle();
  const conferenceLeg: ManagedCall = {
    ...waiting,
    remoteNumber: '15551234567',
    remoteName: '',
    direction: 'outbound',
  };
  lifecycle.setPrimary(primary);
  lifecycle.updatePrimaryDuration(61);
  lifecycle.setWaiting(conferenceLeg);

  assert.equal(lifecycle.established('call-b').kind, 'second');
  assert.deepEqual(lifecycle.ended('call-b'), {
    kind: 'restore-primary',
    ended: conferenceLeg,
    primary: { ...primary, duration: 61 },
  });
});

test('canceling an unanswered outbound conference leg restores the held original call', () => {
  const lifecycle = new CallWaitingLifecycle();
  const conferenceLeg: ManagedCall = {
    ...waiting,
    remoteNumber: '195',
    remoteName: '',
    direction: 'outbound',
  };
  lifecycle.setPrimary(primary);
  lifecycle.updatePrimaryDuration(61);
  lifecycle.setWaiting(conferenceLeg);

  assert.deepEqual(lifecycle.ended('call-b'), {
    kind: 'restore-primary',
    ended: conferenceLeg,
    primary: { ...primary, duration: 61 },
  });
});
