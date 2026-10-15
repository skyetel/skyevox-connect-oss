export type RingtoneName = 'default' | 'classic' | 'digital' | 'soft';

export interface RingtoneSettings {
  name: string;
  outputDeviceId: string;
  volume: number;
}

export interface RingtoneProfile {
  frequencies: readonly number[];
  oscillator: OscillatorType;
  onMs: number;
  offMs: number;
  level: number;
}

export interface TonePlayback {
  stop(): void;
}

export interface RingtoneBackend {
  play(profile: RingtoneProfile, settings: RingtoneSettings, oneShot: boolean): TonePlayback | null;
}

export interface RingtoneAudioEnvironment {
  createContext(): AudioContext | null;
  createAudio(): HTMLAudioElement;
  directOutput: boolean;
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(timer: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timer: number): void;
}

const browserAudioEnvironment: RingtoneAudioEnvironment = {
  createContext: () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    return AudioContextCtor ? new AudioContextCtor() as AudioContext : null;
  },
  createAudio: () => new Audio(),
  directOutput: typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron),
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: (timer) => window.clearInterval(timer),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (timer) => window.clearTimeout(timer),
};

const profiles: Record<RingtoneName, RingtoneProfile> = {
  default: { frequencies: [440, 480], oscillator: 'sine', onMs: 2_000, offMs: 4_000, level: 0.18 },
  classic: { frequencies: [425, 450], oscillator: 'triangle', onMs: 2_000, offMs: 4_000, level: 0.20 },
  digital: { frequencies: [880, 1_046], oscillator: 'square', onMs: 400, offMs: 250, level: 0.10 },
  soft: { frequencies: [330, 392], oscillator: 'sine', onMs: 1_500, offMs: 3_000, level: 0.11 },
};

const callWaitingProfile: RingtoneProfile = {
  frequencies: [440],
  oscillator: 'sine',
  onMs: 300,
  offMs: 0,
  level: 0.12,
};

export function ringtoneProfile(name: string): RingtoneProfile {
  return profiles[name as RingtoneName] ?? profiles.default;
}

export class BrowserRingtoneBackend implements RingtoneBackend {
  private readonly environment: RingtoneAudioEnvironment;

  constructor(environment: RingtoneAudioEnvironment = browserAudioEnvironment) {
    this.environment = environment;
  }

  play(profile: RingtoneProfile, settings: RingtoneSettings, oneShot: boolean): TonePlayback | null {
    let context: AudioContext | null;
    try {
      context = this.environment.createContext();
    } catch (error) {
      console.warn('Incoming ringtone audio context could not be created:', error);
      return null;
    }
    if (!context) {
      console.warn('Incoming ringtone unavailable: Web Audio is not supported.');
      return null;
    }

    let partialGain: GainNode | null = null;
    let partialDestination: MediaStreamAudioDestinationNode | null = null;
    let partialAudio: HTMLAudioElement | null = null;
    const partialOscillators: OscillatorNode[] = [];

    try {
      const gain = context.createGain();
      partialGain = gain;
      const directOutput = this.environment.directOutput;
      const destination = directOutput ? null : context.createMediaStreamDestination();
      partialDestination = destination;
      const audio = directOutput ? null : this.environment.createAudio();
      partialAudio = audio;
      if (audio && destination) {
        audio.autoplay = true;
        audio.volume = 1;
        audio.srcObject = destination.stream;
      }

      const selectedVolume = Math.max(0, Math.min(Number(settings.volume) || 0, 100)) / 100;
      const audibleGain = selectedVolume * profile.level;
      gain.gain.value = audibleGain;
      gain.connect(directOutput ? context.destination : destination!);

      for (const frequency of profile.frequencies) {
        const oscillator = context.createOscillator();
        partialOscillators.push(oscillator);
        oscillator.type = profile.oscillator;
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start();
      }

      let cadenceTimer: number | null = null;
      let stopTimer: number | null = null;
      let startupTimer: number | null = null;
      let stopped = false;
      let playbackStarted = false;
      let directFallback = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (cadenceTimer !== null) this.environment.clearInterval(cadenceTimer);
        if (stopTimer !== null) this.environment.clearTimeout(stopTimer);
        if (startupTimer !== null) this.environment.clearTimeout(startupTimer);
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(0, context.currentTime);
        for (const oscillator of partialOscillators) {
          try {
            oscillator.stop();
          } catch {
            // Already stopped.
          }
          oscillator.disconnect();
        }
        gain.disconnect();
        destination?.disconnect();
        audio?.pause();
        if (audio) audio.srcObject = null;
        void context.close().catch(() => {});
      };
      const startPlaybackTiming = () => {
        if (stopped || playbackStarted) return;
        playbackStarted = true;
        if (startupTimer !== null) {
          this.environment.clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (oneShot) {
          stopTimer = this.environment.setTimeout(stop, profile.onMs);
          return;
        }
        const startedAt = context.currentTime;
        const cycleMs = profile.onMs + profile.offMs;
        const applyCadence = () => {
          const elapsedMs = (context.currentTime - startedAt) * 1_000;
          const audible = cycleMs === 0 || elapsedMs % cycleMs < profile.onMs;
          gain.gain.setTargetAtTime(audible ? audibleGain : 0, context.currentTime, 0.02);
        };
        cadenceTimer = this.environment.setInterval(applyCadence, 100);
        applyCadence();
      };
      const useDirectFallback = (error: unknown) => {
        console.warn('Incoming ringtone media playback failed; using direct Web Audio output:', error);
        if (directFallback || stopped) return;
        directFallback = true;
        try {
          gain.connect(context.destination);
          startPlaybackTiming();
        } catch (fallbackError) {
          console.warn('Incoming ringtone direct audio fallback failed:', fallbackError);
          stop();
        }
      };

      startupTimer = this.environment.setTimeout(stop, 5_000);
      const sinkId = settings.outputDeviceId && settings.outputDeviceId !== 'default'
        ? settings.outputDeviceId
        : '';
      if (directOutput) {
        const sinkContext = context as AudioContext & {
          setSinkId?: (sinkId: string) => Promise<void>;
        };
        const sinkReady = sinkId && sinkContext.setSinkId
          ? sinkContext.setSinkId(sinkId).catch((error) => {
            console.warn('Unable to route incoming ringtone to selected output device:', error);
          })
          : Promise.resolve();
        void sinkReady
          .then(() => context.resume())
          .then(() => startPlaybackTiming())
          .catch((error) => {
            console.warn('Incoming ringtone direct audio output failed:', error);
            stop();
          });
        return { stop };
      }
      const sinkAudio = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      const sinkReady = sinkId && sinkAudio.setSinkId
        ? sinkAudio.setSinkId(sinkId).catch((error) => {
          console.warn('Unable to route incoming ringtone to selected output device:', error);
        })
        : Promise.resolve();
      void sinkReady
        .then(() => context.resume())
        .then(() => {
          if (stopped) return;
          return audio!.play();
        })
        .then(() => startPlaybackTiming())
        .catch(useDirectFallback);
      return { stop };
    } catch (error) {
      for (const oscillator of partialOscillators) {
        try {
          oscillator.stop();
        } catch {
          // It may not have started.
        }
        try {
          oscillator.disconnect();
        } catch {
          // Continue releasing the remaining graph.
        }
      }
      try {
        partialGain?.disconnect();
        partialDestination?.disconnect();
        partialAudio?.pause();
        if (partialAudio) partialAudio.srcObject = null;
      } catch {
        // Best-effort cleanup after partial graph construction.
      }
      void context.close().catch(() => {});
      console.warn('Incoming ringtone could not start:', error);
      return null;
    }
  }
}

export class IncomingRingtoneController {
  private ringing: TonePlayback | null = null;
  private waiting: TonePlayback | null = null;

  private readonly backend: RingtoneBackend;

  constructor(backend: RingtoneBackend = new BrowserRingtoneBackend()) {
    this.backend = backend;
  }

  start(settings: RingtoneSettings): void {
    this.stop();
    this.ringing = this.backend.play(ringtoneProfile(settings.name), settings, false);
  }

  playCallWaiting(settings: RingtoneSettings): void {
    this.stop();
    this.waiting = this.backend.play(callWaitingProfile, settings, true);
  }

  stop(): void {
    this.ringing?.stop();
    this.waiting?.stop();
    this.ringing = null;
    this.waiting = null;
  }
}

export class IncomingCallAlertCoordinator {
  private dndKnown = false;
  private dndEnabled = false;
  private readonly ringtone: IncomingRingtoneController;
  private primarySettings: RingtoneSettings | null = null;

  constructor(ringtone: IncomingRingtoneController = new IncomingRingtoneController()) {
    this.ringtone = ringtone;
  }

  markDndUnknown(): void {
    this.dndKnown = false;
    this.stop();
  }

  setDnd(enabled: boolean): void {
    this.dndKnown = true;
    this.dndEnabled = enabled;
    if (enabled) this.stop();
  }

  incoming(settings: RingtoneSettings, audible = true): boolean {
    if (this.dndKnown && this.dndEnabled) {
      this.stop();
      return false;
    }
    this.stop();
    this.primarySettings = audible ? settings : null;
    if (audible) this.ringtone.start(settings);
    return true;
  }

  callWaiting(settings: RingtoneSettings, audible = true): boolean {
    if (this.dndKnown && this.dndEnabled) {
      this.stop();
      return false;
    }
    if (audible) this.ringtone.playCallWaiting(settings);
    return true;
  }
  endCallWaiting(): void {
    this.ringtone.stop();
    if (this.dndKnown && !this.dndEnabled && this.primarySettings) {
      this.ringtone.start(this.primarySettings);
    }
  }


  stop(): void {
    this.primarySettings = null;
    this.ringtone.stop();
  }
}
