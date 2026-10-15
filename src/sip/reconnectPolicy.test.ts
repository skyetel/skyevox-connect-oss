import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ReconnectRegistrationGate,
  REGISTRATION_RECOVERY_DELAYS_MS,
  RegistrationFinalResponse,
  RegistrationRecoveryScheduler,
  SIP_RECONNECT_OPTIONS,
} from './reconnectPolicy.ts';

test('transport recovery remains enabled across a rolling edge outage', () => {
  assert.ok(SIP_RECONNECT_OPTIONS.reconnectionAttempts >= 30);
  assert.ok(SIP_RECONNECT_OPTIONS.reconnectionDelay >= 1);
  assert.ok(SIP_RECONNECT_OPTIONS.reconnectionDelay <= 10);
});

test('only a recovered transport triggers another REGISTER', () => {
  const gate = new ReconnectRegistrationGate();

  assert.equal(gate.consumeReconnect(), false);
  gate.markDisconnected();
  assert.equal(gate.consumeReconnect(), true);
  assert.equal(gate.consumeReconnect(), false);

  gate.markDisconnected();
  gate.reset();
  assert.equal(gate.consumeReconnect(), false);
});

test('REGISTER dispatch completion does not settle the final response', async () => {
  const outcome = new RegistrationFinalResponse();
  let settled = false;
  void outcome.promise.then(() => { settled = true; });

  await Promise.resolve({ dispatched: true });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(outcome.complete(), true);
  await outcome.promise;
  assert.equal(settled, true);
  assert.equal(outcome.complete(new Error('late rejection')), false);
});

test('definitive REGISTER rejection settles once as failure', async () => {
  const outcome = new RegistrationFinalResponse();
  assert.equal(outcome.complete(new Error('403')), true);
  assert.equal(outcome.complete(), false);
  await assert.rejects(outcome.promise, /403/);
});

function recoveryClock() {
  let nextID = 1;
  const scheduled: Array<{ callback: () => void; delayMs: number; id: number }> = [];
  const cleared: number[] = [];
  return {
    scheduled,
    cleared,
    clock: {
      setTimeout(callback: () => void, delayMs: number) {
        const id = nextID++;
        scheduled.push({ callback, delayMs, id });
        return id;
      },
      clearTimeout(id: number) {
        cleared.push(id);
      },
    },
  };
}

test('unexpected unregister retries with bounded backoff', async () => {
  const fake = recoveryClock();
  let attempts = 0;
  const scheduler = new RegistrationRecoveryScheduler(async () => {
    attempts += 1;
    throw new Error('offline');
  }, fake.clock);

  scheduler.start();
  scheduler.unexpectedUnregistered();
  scheduler.unexpectedUnregistered();
  assert.equal(fake.scheduled.length, 1);
  assert.equal(fake.scheduled[0].delayMs, REGISTRATION_RECOVERY_DELAYS_MS[0]);
  fake.scheduled[0].callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(fake.scheduled[1].delayMs, REGISTRATION_RECOVERY_DELAYS_MS[1]);
  assert.equal(REGISTRATION_RECOVERY_DELAYS_MS.at(-1), 30_000);
});

test('repeated final failures progress through and cap the retry sequence', async () => {
  const fake = recoveryClock();
  const outcomes: RegistrationFinalResponse[] = [];
  const scheduler = new RegistrationRecoveryScheduler(() => {
    const outcome = new RegistrationFinalResponse();
    outcomes.push(outcome);
    return outcome.promise;
  }, fake.clock);
  scheduler.start();
  scheduler.unexpectedUnregistered();

  const expected = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(fake.scheduled[index].delayMs, expected[index]);
    fake.scheduled[index].callback();
    outcomes[index].complete(new Error('registrar unavailable'));
    await Promise.resolve();
    await Promise.resolve();
  }
});

test('registration recovery is single-flight and resets after success', async () => {
  const fake = recoveryClock();
  let finish: (() => void) | null = null;
  let attempts = 0;
  const scheduler = new RegistrationRecoveryScheduler(() => {
    attempts += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  }, fake.clock);

  scheduler.start();
  const first = scheduler.recoverNow();
  const second = scheduler.recoverNow();
  assert.equal(first, second);
  assert.equal(attempts, 1);
  finish?.();
  await first;

  scheduler.unexpectedUnregistered();
  assert.equal(fake.scheduled.at(-1)?.delayMs, REGISTRATION_RECOVERY_DELAYS_MS[0]);
});

test('intentional stop cancels retry and rejects manual recovery', async () => {
  const fake = recoveryClock();
  const scheduler = new RegistrationRecoveryScheduler(async () => {}, fake.clock);
  scheduler.start();
  scheduler.unexpectedUnregistered();
  const pending = fake.scheduled[0];
  await scheduler.stop();
  assert.deepEqual(fake.cleared, [pending.id]);
  pending.callback();
  await Promise.resolve();
  await assert.rejects(scheduler.recoverNow(), /stopped/);
});

test('intentional stop drains an in-flight registration before disconnect continues', async () => {
  const fake = recoveryClock();
  let finish: (() => void) | null = null;
  const scheduler = new RegistrationRecoveryScheduler(
    () => new Promise<void>((resolve) => { finish = resolve; }),
    fake.clock,
  );
  scheduler.start();
  const recovery = scheduler.recoverNow();
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish?.();
  await recovery;
  await stopping;
  assert.equal(stopped, true);
  assert.equal(fake.scheduled.length, 0);
});
