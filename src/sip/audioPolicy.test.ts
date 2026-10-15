import assert from 'node:assert/strict';
import test from 'node:test';

import { canUseDirectAudioPath, conferenceMixTracksFor } from './audioPolicy.ts';

test('direct WebAudio remains valid for the system default output', () => {
  assert.equal(canUseDirectAudioPath('', false), true);
});

test('selected output falls back to the sink-selectable audio element', () => {
  assert.equal(canUseDirectAudioPath('headset-device', false), false);
  assert.equal(canUseDirectAudioPath('headset-device', true), true);
});

test('local conference sends the microphone and every other caller to each recipient', () => {
  const microphoneA = { id: 'mic-a' };
  const microphoneB = { id: 'mic-b' };
  const remoteA = { id: 'remote-a' };
  const remoteB = { id: 'remote-b' };
  const endpoints = [
    { id: 'call-a', localTrack: microphoneA, remoteTracks: [remoteA] },
    { id: 'call-b', localTrack: microphoneB, remoteTracks: [remoteB] },
  ];

  assert.deepEqual(conferenceMixTracksFor(endpoints, 'call-a'), [microphoneA, remoteB]);
  assert.deepEqual(conferenceMixTracksFor(endpoints, 'call-b'), [microphoneB, remoteA]);
});

test('local conference refuses to claim success without two established calls', () => {
  assert.throws(
    () => conferenceMixTracksFor([{ id: 'call-a', localTrack: {}, remoteTracks: [] }], 'call-a'),
    /at least two established calls/,
  );
});
