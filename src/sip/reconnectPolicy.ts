export const SIP_RECONNECT_OPTIONS = {
  reconnectionAttempts: 60,
  reconnectionDelay: 4,
} as const;

export class ReconnectRegistrationGate {
  private transportDisconnected = false;

  markDisconnected(): void {
    this.transportDisconnected = true;
  }

  consumeReconnect(): boolean {
    if (!this.transportDisconnected) return false;
    this.transportDisconnected = false;
    return true;
  }

  reset(): void {
    this.transportDisconnected = false;
  }
}

export class RegistrationFinalResponse {
  readonly promise: Promise<void>;
  private settled = false;
  private resolve!: () => void;
  private reject!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  complete(error?: Error): boolean {
    if (this.settled) return false;
    this.settled = true;
    if (error) this.reject(error);
    else this.resolve();
    return true;
  }
}

export const REGISTRATION_RECOVERY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

type RecoveryTimer = number;

interface RegistrationRecoveryClock {
  setTimeout(callback: () => void, delayMs: number): RecoveryTimer;
  clearTimeout(timer: RecoveryTimer): void;
}

const browserRecoveryClock: RegistrationRecoveryClock = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (timer) => window.clearTimeout(timer),
};

export class RegistrationRecoveryScheduler {
  private active = false;
  private attempt = 0;
  private timer: RecoveryTimer | null = null;
  private inFlight: Promise<void> | null = null;

  private readonly recover: () => Promise<void>;
  private readonly clock: RegistrationRecoveryClock;

  constructor(
    recover: () => Promise<void>,
    clock: RegistrationRecoveryClock = browserRecoveryClock,
  ) {
    this.recover = recover;
    this.clock = clock;
  }

  start(): void {
    this.active = true;
    this.registered();
  }

  registered(): void {
    this.attempt = 0;
    this.clearTimer();
  }

  unexpectedUnregistered(): void {
    this.schedule();
  }

  recoverNow(): Promise<void> {
    if (!this.active) {
      return Promise.reject(new Error('SIP registration recovery is stopped.'));
    }
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    let failed = false;
    const operation = (async () => {
      try {
        await this.recover();
        this.registered();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        this.inFlight = null;
        if (failed) this.schedule();
      }
    })();
    this.inFlight = operation;
    return operation;
  }
  async stop(): Promise<void> {
    this.active = false;
    this.attempt = 0;
    this.clearTimer();
    await this.inFlight?.catch(() => {});
  }

  private schedule(): void {
    if (!this.active || this.timer !== null || this.inFlight) return;
    const delay = REGISTRATION_RECOVERY_DELAYS_MS[
      Math.min(this.attempt, REGISTRATION_RECOVERY_DELAYS_MS.length - 1)
    ];
    this.attempt += 1;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.recoverNow().catch(() => {});
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
