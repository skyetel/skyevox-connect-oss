export interface ManagedCall {
  sessionId: string;
  remoteNumber: string;
  remoteName: string;
  direction: 'inbound' | 'outbound';
  duration: number;
}

export type CallEstablishedTransition =
  | { kind: 'primary'; call: ManagedCall }
  | { kind: 'second'; call: ManagedCall; primary: ManagedCall | null }
  | { kind: 'unknown' };

export type CallEndedTransition =
  | { kind: 'waiting-ended'; ended: ManagedCall; primary: ManagedCall | null }
  | { kind: 'promote-waiting'; ended: ManagedCall; promoted: ManagedCall }
  | { kind: 'restore-primary'; ended: ManagedCall; primary: ManagedCall }
  | { kind: 'second-ended'; ended: ManagedCall }
  | { kind: 'primary-ended-under-second'; ended: ManagedCall; active: ManagedCall }
  | { kind: 'all-ended'; ended: ManagedCall }
  | { kind: 'unknown' };

export class CallWaitingLifecycle {
  private primary: ManagedCall | null = null;
  private waiting: ManagedCall | null = null;
  private activeSecond: ManagedCall | null = null;

  setPrimary(call: ManagedCall): void {
    this.primary = { ...call };
  }

  setWaiting(call: ManagedCall): void {
    this.waiting = { ...call };
  }

  updatePrimaryDuration(duration: number): void {
    if (this.primary) this.primary.duration = duration;
  }

  established(sessionId: string): CallEstablishedTransition {
    if (this.waiting?.sessionId === sessionId) {
      this.activeSecond = this.waiting;
      this.waiting = null;
      return { kind: 'second', call: { ...this.activeSecond }, primary: this.primary ? { ...this.primary } : null };
    }
    if (this.primary?.sessionId === sessionId) {
      return { kind: 'primary', call: { ...this.primary } };
    }
    return { kind: 'unknown' };
  }

  ended(sessionId: string): CallEndedTransition {
    if (this.waiting?.sessionId === sessionId) {
      const ended = this.waiting;
      this.waiting = null;
      if (ended.direction === 'outbound' && this.primary) {
        return { kind: 'restore-primary', ended: { ...ended }, primary: { ...this.primary } };
      }
      return { kind: 'waiting-ended', ended: { ...ended }, primary: this.primary ? { ...this.primary } : null };
    }

    if (this.activeSecond?.sessionId === sessionId) {
      const ended = this.activeSecond;
      this.activeSecond = null;
      if (this.primary) {
        return { kind: 'restore-primary', ended: { ...ended }, primary: { ...this.primary } };
      }
      return { kind: 'second-ended', ended: { ...ended } };
    }

    if (this.primary?.sessionId === sessionId) {
      const ended = this.primary;
      this.primary = null;
      if (this.waiting) {
        const promoted = this.waiting;
        this.waiting = null;
        this.primary = promoted;
        return { kind: 'promote-waiting', ended: { ...ended }, promoted: { ...promoted } };
      }
      if (this.activeSecond) {
        return { kind: 'primary-ended-under-second', ended: { ...ended }, active: { ...this.activeSecond } };
      }
      return { kind: 'all-ended', ended: { ...ended } };
    }

    return { kind: 'unknown' };
  }

  clear(): void {
    this.primary = null;
    this.waiting = null;
    this.activeSecond = null;
  }
}
