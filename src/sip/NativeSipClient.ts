import type { PluginListenerHandle } from '@capacitor/core';
import { SkyeVoxNative, type NativeCallEvent, type NativeRegistrationEvent } from '../native/SkyeVoxNative';
import type { SipConfig } from '../types';
import { answerSecondCallTransaction } from './secondCallAnswer';

export interface NativeInvitation {
  nativeCallId: string;
  remoteIdentity: {
    displayName: string;
    uri: {
      user: string;
    };
  };
  reject: () => Promise<void>;
}

interface NativeSession {
  id: string;
  state: NativeCallEvent['state'];
  direction: NativeCallEvent['direction'];
  remoteNumber: string;
  remoteName: string;
  held: boolean;
  /** True once the call has reached 'active' at least once (timer started). */
  established: boolean;
}

export class NativeSipClient {
  private config: SipConfig;
  private sessions = new Map<string, NativeSession>();
  private activeSessionId: string | null = null;
  private muted = false;
  private conferenceSessionIds: string[] | null = null;
  private isolatedSessionIds = new Set<string>();
  private holdPending = false;
  private registrationListener: PluginListenerHandle | null = null;
  private callListener: PluginListenerHandle | null = null;

  public onRegistered: (() => void) | null = null;
  public onUnregistered: (() => void) | null = null;
  public onIncomingCall: ((invitation: NativeInvitation) => void) | null = null;
  public onCallEstablished: ((sessionId: string) => void) | null = null;
  public onCallEnded: ((sessionId: string) => void) | null = null;
  /** Fired when a held call returns to 'active'; never restarts the call timer. */
  public onCallResumed: ((sessionId: string) => void) | null = null;
  public onSecondIncomingCall: ((invitation: NativeInvitation) => void) | null = null;
  public onConferenceMerged: (() => void) | null = null;

  constructor(config: SipConfig) {
    this.config = config;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get conferenceActive(): boolean {
    return this.conferenceSessionIds !== null;
  }

  get hasActiveCall(): boolean {
    return Boolean(this.activeSessionId && this.sessions.has(this.activeSessionId));
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getEstablishedParticipants(): Array<{ id: string; name: string; number: string }> {
    return Array.from(this.sessions.values())
      .filter((session) => session.established)
      .map((session) => ({ id: session.id, name: session.remoteName, number: session.remoteNumber }));
  }

  getPeerConnection(): RTCPeerConnection | null {
    return null;
  }

  getHeldSessionIds(): string[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.held)
      .map((session) => session.id);
  }

  async connect(): Promise<void> {
    this.registrationListener = await SkyeVoxNative.addListener('registrationChanged', (event) => this.handleRegistration(event));
    this.callListener = await SkyeVoxNative.addListener('callChanged', (event) => this.handleCall(event));
    await SkyeVoxNative.configure({ config: this.config });
    await SkyeVoxNative.register();
  }

  async disconnect(): Promise<void> {
    for (const id of Array.from(this.sessions.keys())) {
      await this.hangup(id).catch(() => {});
    }
    this.sessions.clear();
    this.conferenceSessionIds = null;
    this.isolatedSessionIds.clear();
    this.activeSessionId = null;
    await SkyeVoxNative.unregister().catch(() => {});
    await this.registrationListener?.remove();
    await this.callListener?.remove();
    this.registrationListener = null;
    this.callListener = null;
  }

  async call(target: string): Promise<string> {
    const result = await SkyeVoxNative.call({ destination: target });
    const session = this.upsertSession({
      callId: result.callId,
      state: 'dialing',
      direction: 'outbound',
      remoteNumber: target,
    });
    this.activeSessionId = session.id;
    return session.id;
  }

  async answer(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return;
    await SkyeVoxNative.answer({ callId: id });
  }

  async hangup(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return;
    await SkyeVoxNative.hangup({ callId: id });
  }

  async hold(sessionId?: string): Promise<void> {
    await this.changeHold(true, sessionId);
  }

  async unhold(sessionId?: string): Promise<void> {
    await this.changeHold(false, sessionId);
  }

  private async setNativeSessionHeld(id: string, held: boolean): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.established) throw new Error('The native call is no longer available.');
    if (session.held === held) return;
    // The native bridge acknowledges SDK initiation, not final SIP/media acceptance.
    if (held) await SkyeVoxNative.hold({ callId: id });
    else await SkyeVoxNative.unhold({ callId: id });
    if (this.sessions.get(id) !== session) throw new Error('The native call ended during hold or resume.');
    session.held = held;
    session.state = held ? 'held' : 'active';
  }

  private async changeHold(held: boolean, sessionId?: string): Promise<void> {
    if (this.holdPending) throw new Error('Hold or conference control is already in progress.');
    const conference = sessionId === undefined ? this.conferenceSessionIds : null;
    const ids = conference ?? [sessionId ?? this.activeSessionId];
    const participants = ids.map((id) => {
      if (!id) throw new Error('No active call to change hold state.');
      const session = this.sessions.get(id);
      if (!session?.established) throw new Error('The native call is no longer available.');
      return { id, session, wasHeld: session.held, wasIsolated: this.isolatedSessionIds.has(id) };
    });
    this.holdPending = true;
    try {
      if (!conference) {
        const { id } = participants[0];
        await this.setNativeSessionHeld(id, held);
        if (!held && this.isolatedSessionIds.has(id) && !this.conferenceSessionIds?.includes(id)) {
          await SkyeVoxNative.mute({ callId: id, muted: this.muted });
          this.isolatedSessionIds.delete(id);
        }
        if (!held) this.activeSessionId = id;
        return;
      }
      participants.forEach(({ id }) => this.isolatedSessionIds.add(id));
      const isolation = await Promise.allSettled(participants.map(({ id }) => SkyeVoxNative.mute({ callId: id, muted: true })));
      const isolationFailures = isolation.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (isolationFailures.length) {
        throw new AggregateError(isolationFailures, 'Native conference hold was not changed: microphone isolation could not be confirmed.');
      }
      const results = await Promise.allSettled(participants.map(({ id }) => this.setNativeSessionHeld(id, held)));
      const current = () => this.conferenceSessionIds === conference &&
        participants.every(({ id, session }) => this.sessions.get(id) === session);
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (!current()) failures.push(new Error('Native conference membership changed during hold or resume.'));
      if (failures.length) {
        const rollback = await Promise.allSettled(participants.map(async ({ id, wasHeld }, index) => {
          if (results[index].status === 'fulfilled' && wasHeld !== held) await this.setNativeSessionHeld(id, wasHeld);
        }));
        const rollbackFailures = rollback.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (current() && !rollbackFailures.length && participants.every(({ wasIsolated }) => !wasIsolated)) {
          await this.restoreConferenceMicrophones(participants.map(({ id }) => id));
        }
        throw new AggregateError([...failures, ...rollbackFailures],
          rollbackFailures.length || !current()
            ? 'Native conference hold state is incomplete; microphones remain muted. Retry the control or end the calls.'
            : 'Native conference hold or resume failed; prior SDK hold state was restored.');
      }
      if (!held) await this.restoreConferenceMicrophones(participants.map(({ id }) => id));
    } finally {
      this.holdPending = false;
    }
  }

  private async restoreConferenceMicrophones(ids: string[]): Promise<void> {
    const sessions = ids.map((id) => this.sessions.get(id));
    const failures: unknown[] = [];
    let muted: boolean;
    do {
      muted = this.muted;
      const results = await Promise.allSettled(ids.map((id) => SkyeVoxNative.mute({ callId: id, muted })));
      failures.push(...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    } while (!failures.length && muted !== this.muted);
    if (ids.some((id, index) => !sessions[index] || this.sessions.get(id) !== sessions[index])) {
      failures.push(new Error('Native conference membership changed during microphone restoration.'));
    }
    if (failures.length) {
      const isolation = await Promise.allSettled(ids.map((id) => SkyeVoxNative.mute({ callId: id, muted: true })));
      const isolationFailures = isolation.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      throw new AggregateError([...failures, ...isolationFailures], isolationFailures.length
        ? 'Native microphone restoration failed and isolation could not be confirmed. End the calls.'
        : 'Native microphone restoration failed; microphones remain muted. Retry the control.');
    }
    ids.forEach((id) => this.isolatedSessionIds.delete(id));
  }

  toggleMute(sessionId?: string): boolean {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return this.muted;
    this.muted = !this.muted;
    if (this.isolatedSessionIds.has(id)) return this.muted;
    SkyeVoxNative.mute({ callId: id, muted: this.muted }).catch(() => {
      this.muted = !this.muted;
    });
    return this.muted;
  }

  sendDTMF(digit: string, sessionId?: string): void {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return;
    SkyeVoxNative.sendDtmf({ callId: id, digit }).catch(() => {});
  }

  async transfer(target: string, sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return;
    await SkyeVoxNative.transfer({ callId: id, destination: target });
  }

  async conferenceCall(target: string): Promise<string | null> {
    if (this.activeSessionId) await this.hold(this.activeSessionId);
    return this.call(target);
  }

  async mergeCall(): Promise<void> {
    if (this.conferenceSessionIds) return;
    if (this.holdPending) throw new Error('Wait for the current hold operation to complete.');
    const participants = Array.from(this.sessions.values()).filter((session) => session.established);
    if (participants.length !== 2) throw new Error('Wait for both calls to connect before merging.');
    this.holdPending = true;
    try {
      for (const session of participants) {
        if (session.held) await this.setNativeSessionHeld(session.id, false);
      }
      if (participants.some((session) => this.sessions.get(session.id) !== session)) {
        throw new Error('A native participant ended before the conference completed.');
      }
      const isolated = participants.filter((session) => this.isolatedSessionIds.has(session.id));
      if (isolated.length) await this.restoreConferenceMicrophones(isolated.map((session) => session.id));
      this.conferenceSessionIds = participants.map((session) => session.id);
    } finally {
      this.holdPending = false;
    }
    this.onConferenceMerged?.();
  }

  async splitConference(): Promise<void> {
    if (this.holdPending) throw new Error('Wait for the current hold operation to complete.');
    this.holdPending = true;
    try {
      for (const id of this.conferenceSessionIds ?? Array.from(this.sessions.keys())) {
        if (id !== this.activeSessionId) await this.setNativeSessionHeld(id, true);
      }
      this.conferenceSessionIds = null;
    } finally {
      this.holdPending = false;
    }
  }

  async dropParticipant(sessionId: string): Promise<void> {
    await this.hangup(sessionId);
  }

  async swapCalls(): Promise<string | null> {
    const heldId = this.getHeldSessionIds()[0];
    const currentId = this.activeSessionId;
    if (!heldId || !currentId) return null;
    await this.hold(currentId);
    await this.unhold(heldId);
    return heldId;
  }

  async answerSecondCall(sessionId: string): Promise<void> {
    const previousSessionId = this.activeSessionId;
    this.activeSessionId = await answerSecondCallTransaction(previousSessionId, sessionId, {
      hold: (id) => this.hold(id),
      answer: (id) => this.answer(id),
      unhold: (id) => this.unhold(id),
    });
  }

  async rejectSecondCall(sessionId: string): Promise<void> {
    await SkyeVoxNative.reject({ callId: sessionId });
    this.sessions.delete(sessionId);
  }

  findSessionId(session: NativeInvitation): string | null {
    return session.nativeCallId || null;
  }

  private handleRegistration(event: NativeRegistrationEvent): void {
    if (event.state === 'registered') this.onRegistered?.();
    if (event.state === 'unregistered' || event.state === 'failed') this.onUnregistered?.();
  }

  private handleCall(event: NativeCallEvent): void {
    const session = this.upsertSession(event);
    if (event.state === 'incoming') {
      const invitation = this.invitationFor(session);
      if (this.hasActiveCall && this.activeSessionId !== session.id) {
        this.onSecondIncomingCall?.(invitation);
      } else {
        this.activeSessionId = session.id;
        this.onIncomingCall?.(invitation);
      }
      return;
    }

    if (event.state === 'active') {
      const wasHeld = session.held;
      session.held = false;
      if (!this.conferenceSessionIds?.includes(session.id)) this.activeSessionId = session.id;
      // liblinphone reports Connected, StreamsRunning, Updating, UpdatedByRemote and Resuming
      // all as 'active'. Only the first one is call establishment; later ones (re-INVITEs,
      // resume from hold) must not restart the UI call timer.
      if (!session.established) {
        session.established = true;
        this.onCallEstablished?.(session.id);
      } else if (wasHeld) {
        this.onCallResumed?.(session.id);
      }
      return;
    }

    if (event.state === 'held') {
      session.held = true;
      return;
    }

    if (event.state === 'ended' || event.state === 'failed') {
      if (this.conferenceSessionIds?.includes(session.id)) this.conferenceSessionIds = null;
      this.isolatedSessionIds.delete(session.id);
      this.sessions.delete(session.id);
      if (this.activeSessionId === session.id) {
        this.activeSessionId = this.sessions.keys().next().value ?? null;
      }
      this.onCallEnded?.(session.id);
    }
  }

  private upsertSession(event: Pick<NativeCallEvent, 'callId' | 'state' | 'direction' | 'remoteNumber' | 'remoteName'>): NativeSession {
    const existing = this.sessions.get(event.callId);
    if (existing) {
      existing.state = event.state;
      existing.direction = event.direction || existing.direction;
      existing.remoteNumber = event.remoteNumber || existing.remoteNumber;
      existing.remoteName = event.remoteName || existing.remoteName;
      return existing;
    }

    const session: NativeSession = {
      id: event.callId,
      state: event.state,
      direction: event.direction || 'outbound',
      remoteNumber: event.remoteNumber || '',
      remoteName: event.remoteName || '',
      held: false,
      established: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private invitationFor(session: NativeSession): NativeInvitation {
    return {
      nativeCallId: session.id,
      remoteIdentity: {
        displayName: session.remoteName,
        uri: {
          user: session.remoteNumber,
        },
      },
      reject: () => this.rejectSecondCall(session.id),
    };
  }
}
