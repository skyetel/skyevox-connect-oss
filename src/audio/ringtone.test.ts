import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserRingtoneBackend,
  IncomingCallAlertCoordinator,
  IncomingRingtoneController,
  ringtoneProfile,
  type RingtoneBackend,
  type RingtoneProfile,
  type RingtoneSettings,
  type RingtoneAudioEnvironment,
  type TonePlayback,
} from './ringtone.ts';

class FakePlayback implements TonePlayback {
  stops = 0;

  stop(): void {
    this.stops += 1;
  }
}

class FakeBackend implements RingtoneBackend {
  calls: Array<{
    profile: RingtoneProfile;
    settings: RingtoneSettings;
    oneShot: boolean;
    playback: FakePlayback;
  }> = [];

  play(profile: RingtoneProfile, settings: RingtoneSettings, oneShot: boolean): TonePlayback {
    const playback = new FakePlayback();
    this.calls.push({ profile, settings, oneShot, playback });
    return playback;
  }
}

class FakeAudioEnvironment implements RingtoneAudioEnvironment {
  contextAvailable = true;
  directOutput = false;
  contextClosed = 0;
  contextResumed = 0;
  playCalls = 0;
  pauseCalls = 0;
  sinkIDs: string[] = [];
  contextSinkIDs: string[] = [];
  gainConnections: unknown[] = [];
  oscillators: Array<{ frequency: number; type: OscillatorType; starts: number; stops: number }> = [];
  intervals: Array<{ callback: () => void; delayMs: number; id: number }> = [];
  timeouts: Array<{ callback: () => void; delayMs: number; id: number }> = [];
  clearedIntervals: number[] = [];
  clearedTimeouts: number[] = [];
  playError: Error | null = null;
  throwOnCreateAudio = false;
  sinkReady: Promise<void> = Promise.resolve();
  readonly mediaStream = {};
  readonly contextDestination = {};
  private fallbackResolve: () => void = () => {};
  readonly fallbackConnected = new Promise<void>((resolve) => { this.fallbackResolve = resolve; });
  readonly gainParam = {
    value: 0,
    cancelScheduledValues: () => {},
    setValueAtTime: (value: number) => { this.gainParam.value = value; },
    setTargetAtTime: (value: number) => { this.gainParam.value = value; },
  };
  readonly gain = {
    gain: this.gainParam,
    connect: (target: unknown) => {
      this.gainConnections.push(target);
      if (target === this.contextDestination) this.fallbackResolve();
    },
    disconnect: () => {},
  };
  readonly destination = {
    stream: this.mediaStream,
    disconnect: () => {},
  };
  readonly audio = {
    volume: 0,
    paused: true,
    srcObject: null as unknown,
    setSinkId: (id: string) => {
      this.sinkIDs.push(id);
      return this.sinkReady;
    },
    play: () => {
      this.playCalls += 1;
      if (this.playError) return Promise.reject(this.playError);
      this.audio.paused = false;
      return Promise.resolve();
    },
    pause: () => {
      this.pauseCalls += 1;
      this.audio.paused = true;
    },
  };
  readonly context = {
    currentTime: 1,
    setSinkId: (id: string) => {
      this.contextSinkIDs.push(id);
      return Promise.resolve();
    },
    destination: this.contextDestination,
    createGain: () => this.gain,
    createMediaStreamDestination: () => this.destination,
    createOscillator: () => {
      const state = { frequency: 0, type: 'sine' as OscillatorType, starts: 0, stops: 0 };
      this.oscillators.push(state);
      return {
        get type() { return state.type; },
        set type(value: OscillatorType) { state.type = value; },
        frequency: {
          get value() { return state.frequency; },
          set value(value: number) { state.frequency = value; },
        },
        connect: () => {},
        disconnect: () => {},
        start: () => { state.starts += 1; },
        stop: () => { state.stops += 1; },
      };
    },
    resume: () => {
      this.contextResumed += 1;
      return Promise.resolve();
    },
    close: () => {
      this.contextClosed += 1;
      return Promise.resolve();
    },
  };

  createContext(): AudioContext | null {
    return this.contextAvailable ? this.context as unknown as AudioContext : null;
  }

  createAudio(): HTMLAudioElement {
    if (this.throwOnCreateAudio) throw new Error('audio construction failed');
    return this.audio as unknown as HTMLAudioElement;
  }

  setInterval(callback: () => void, delayMs: number): number {
    const id = this.intervals.length + 1;
    this.intervals.push({ callback, delayMs, id });
    return id;
  }

  clearInterval(id: number): void {
    this.clearedIntervals.push(id);
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.timeouts.length + 101;
    this.timeouts.push({ callback, delayMs, id });
    return id;
  }

  clearTimeout(id: number): void {
    this.clearedTimeouts.push(id);
  }
}

const settings: RingtoneSettings = {
  name: 'digital',
  outputDeviceId: 'speaker-2',
  volume: 70,
};

test('ringtone selections have distinct audible profiles and safe fallback', () => {
  const fallback = ringtoneProfile('unknown');
  assert.deepEqual(fallback, ringtoneProfile('default'));
  assert.notDeepEqual(ringtoneProfile('classic'), fallback);
  assert.notDeepEqual(ringtoneProfile('digital'), fallback);
  assert.notDeepEqual(ringtoneProfile('soft'), fallback);
  for (const name of ['default', 'classic', 'digital', 'soft']) {
    const profile = ringtoneProfile(name);
    assert.ok(profile.frequencies.length > 0);
    assert.ok(profile.onMs > 0);
    assert.ok(profile.level > 0 && profile.level <= 1);
  }
});

test('incoming ringtone uses selected output settings and replaces prior playback', () => {
  const backend = new FakeBackend();
  const controller = new IncomingRingtoneController(backend);
  controller.start(settings);
  controller.start({ ...settings, name: 'soft' });

  assert.equal(backend.calls.length, 2);
  assert.equal(backend.calls[0].oneShot, false);
  assert.equal(backend.calls[0].settings.outputDeviceId, 'speaker-2');
  assert.equal(backend.calls[0].settings.volume, 70);
  assert.equal(backend.calls[0].playback.stops, 1);
  assert.equal(backend.calls[1].playback.stops, 0);

  controller.stop();
  assert.equal(backend.calls[1].playback.stops, 1);
  controller.stop();
  assert.equal(backend.calls[1].playback.stops, 1);
});

test('call-waiting tone is one-shot and never overlaps full ringing', () => {
  const backend = new FakeBackend();
  const controller = new IncomingRingtoneController(backend);
  controller.start(settings);
  controller.playCallWaiting(settings);

  assert.equal(backend.calls.length, 2);
  assert.equal(backend.calls[0].playback.stops, 1);
  assert.equal(backend.calls[1].oneShot, true);

  controller.start(settings);
  assert.equal(backend.calls[1].playback.stops, 1);
  assert.equal(backend.calls[2].oneShot, false);
});

test('ending a second ringing call resumes the still-ringing primary call', () => {
  const backend = new FakeBackend();
  const ringtone = new IncomingRingtoneController(backend);
  const alerts = new IncomingCallAlertCoordinator(ringtone);
  alerts.setDnd(false);

  assert.equal(alerts.incoming(settings), true);
  assert.equal(alerts.callWaiting({ ...settings, name: 'soft' }), true);
  alerts.endCallWaiting();

  assert.equal(backend.calls.length, 3);
  assert.equal(backend.calls[0].oneShot, false);
  assert.equal(backend.calls[0].playback.stops, 1);
  assert.equal(backend.calls[1].oneShot, true);
  assert.equal(backend.calls[1].playback.stops, 1);
  assert.equal(backend.calls[2].oneShot, false);
  assert.deepEqual(backend.calls[2].settings, settings);

  alerts.setDnd(true);
  alerts.endCallWaiting();
  assert.equal(backend.calls.length, 3);
});

test('unknown DND state does not reject inbound calls, while enabled DND does', () => {
  const backend = new FakeBackend();
  const ringtone = new IncomingRingtoneController(backend);
  const alerts = new IncomingCallAlertCoordinator(ringtone);

  assert.equal(alerts.incoming(settings), true);
  assert.equal(backend.calls.length, 1);

  alerts.setDnd(true);
  assert.equal(backend.calls[0].playback.stops, 1);
  assert.equal(alerts.incoming(settings), false);
  assert.equal(backend.calls.length, 1);

  alerts.setDnd(false);
  assert.equal(alerts.incoming(settings), true);
  assert.equal(backend.calls.length, 2);
});

test('DND reload and disconnect stop active ringtone exactly once', () => {
  const backend = new FakeBackend();
  const ringtone = new IncomingRingtoneController(backend);
  const alerts = new IncomingCallAlertCoordinator(ringtone);
  alerts.setDnd(false);
  alerts.incoming(settings);
  alerts.markDndUnknown();
  assert.equal(backend.calls[0].playback.stops, 1);

  alerts.setDnd(false);
  alerts.callWaiting(settings);
  alerts.stop();
  alerts.stop();
  assert.equal(backend.calls[1].oneShot, true);
  assert.equal(backend.calls[1].playback.stops, 1);
});

test('browser backend drives selected sink, profile, volume, cadence, and cleanup', async () => {
  const environment = new FakeAudioEnvironment();
  const backend = new BrowserRingtoneBackend(environment);
  const profile = ringtoneProfile('digital');
  const playback = backend.play(profile, settings, false);
  assert.ok(playback);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(environment.sinkIDs, ['speaker-2']);
  assert.equal(environment.playCalls, 1);
  assert.equal(environment.contextResumed, 1);
  assert.equal(environment.gainParam.value, 0.7 * profile.level);
  assert.deepEqual(environment.oscillators.map(item => item.frequency), [...profile.frequencies]);
  assert.ok(environment.oscillators.every(item => item.type === profile.oscillator && item.starts === 1));
  assert.equal(environment.intervals[0].delayMs, 100);

  playback.stop();
  assert.equal(environment.contextClosed, 1);
  assert.equal(environment.pauseCalls, 1);
  assert.equal(environment.audio.srcObject, null);
  assert.deepEqual(environment.clearedIntervals, [environment.intervals[0].id]);
  assert.ok(environment.oscillators.every(item => item.stops === 1));
});

test('desktop ringtone uses direct AudioContext output instead of a media element hop', async () => {
  const environment = new FakeAudioEnvironment();
  environment.directOutput = true;
  const playback = new BrowserRingtoneBackend(environment).play(
    ringtoneProfile('default'),
    settings,
    false,
  );
  assert.ok(playback);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(environment.gainConnections, [environment.contextDestination]);
  assert.equal(environment.contextResumed, 1);
  assert.deepEqual(environment.contextSinkIDs, ['speaker-2']);
  assert.equal(environment.playCalls, 0);
  assert.equal(environment.intervals.length, 1);

  playback.stop();
  assert.equal(environment.contextClosed, 1);
});

test('browser backend cannot resurrect playback after stop while sink selection waits', async () => {
  const environment = new FakeAudioEnvironment();
  let releaseSink: (() => void) | null = null;
  environment.sinkReady = new Promise<void>((resolve) => { releaseSink = resolve; });
  const playback = new BrowserRingtoneBackend(environment).play(ringtoneProfile('default'), settings, false);
  assert.ok(playback);
  playback.stop();
  releaseSink?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(environment.playCalls, 0);
  assert.equal(environment.contextClosed, 1);
});

test('one-shot duration starts after selected speaker routing becomes audible', async () => {
  const environment = new FakeAudioEnvironment();
  let releaseSink: (() => void) | null = null;
  environment.sinkReady = new Promise<void>((resolve) => { releaseSink = resolve; });
  const profile = ringtoneProfile('default');
  const playback = new BrowserRingtoneBackend(environment).play(profile, settings, true);
  assert.ok(playback);
  assert.deepEqual(environment.timeouts.map(item => item.delayMs), [5_000]);

  releaseSink?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(environment.playCalls, 1);
  assert.deepEqual(environment.timeouts.map(item => item.delayMs), [5_000, profile.onMs]);
  assert.deepEqual(environment.clearedTimeouts, [environment.timeouts[0].id]);

  environment.timeouts[1].callback();
  assert.equal(environment.contextClosed, 1);
});

test('partial backend construction failure closes its AudioContext', () => {
  const environment = new FakeAudioEnvironment();
  environment.throwOnCreateAudio = true;
  const playback = new BrowserRingtoneBackend(environment).play(ringtoneProfile('default'), settings, false);
  assert.equal(playback, null);
  assert.equal(environment.contextClosed, 1);
});

test('browser backend falls back to direct audio and handles missing Web Audio', async () => {
  const environment = new FakeAudioEnvironment();
  environment.playError = new Error('autoplay rejected');
  const playback = new BrowserRingtoneBackend(environment).play(ringtoneProfile('soft'), settings, false);
  assert.ok(playback);
  await environment.fallbackConnected;
  assert.equal(environment.gainConnections.includes(environment.contextDestination), true);
  playback.stop();

  environment.contextAvailable = false;
  assert.equal(new BrowserRingtoneBackend(environment).play(ringtoneProfile('soft'), settings, false), null);
});
