import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accumulateQuality,
  appendQualityHistory,
  qualityAverages,
  shouldLogDiagnostics,
  type QualityAggregate,
} from './useCallQuality.ts';
import type { CallQualityMetrics } from '../types.ts';

const sample = (mos: number): CallQualityMetrics => ({
  mos,
  jitter: mos * 2,
  packetLoss: mos / 10,
  rtt: 20,
  bitrate: 64,
  codec: 'opus',
  quality: 'good',
});

test('quality history stays bounded to the requested sample count', () => {
  let history: CallQualityMetrics[] = [];
  assert.deepEqual(appendQualityHistory([sample(5)], sample(6), 1).map((entry) => entry.mos), [6]);
  for (let index = 1; index <= 5; index += 1) {
    history = appendQualityHistory(history, sample(index), 3);
  }
  assert.deepEqual(history.map((entry) => entry.mos), [3, 4, 5]);
});

test('running quality aggregate preserves whole-call averages after history eviction', () => {
  let aggregate: QualityAggregate | null = null;
  for (let index = 1; index <= 5; index += 1) {
    aggregate = accumulateQuality(aggregate, sample(index));
  }
  assert.deepEqual(qualityAverages(aggregate), {
    avgMos: 3,
    avgJitter: 6,
    avgPacketLoss: 0.3,
  });
});

test('desktop diagnostics reuse every third quality sample', () => {
  assert.equal(shouldLogDiagnostics(1), false);
  assert.equal(shouldLogDiagnostics(2), false);
  assert.equal(shouldLogDiagnostics(3), true);
  assert.equal(shouldLogDiagnostics(6), true);
});
