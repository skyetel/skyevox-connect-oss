import { UserAgent, Registerer, Inviter, SessionState, RegistererState, Web } from 'sip.js';
import type { Session, Invitation } from 'sip.js';
import type { SipConfig } from '../types';
import { normalizeSipHost, normalizeSipUser } from '../config';
import { ReconnectRegistrationGate, RegistrationFinalResponse, RegistrationRecoveryScheduler, SIP_RECONNECT_OPTIONS } from './reconnectPolicy';
import { canUseDirectAudioPath, conferenceMixTracksFor, type ConferenceAudioEndpoint } from './audioPolicy';
import { resolveIceServers } from './iceServers';
import { loadSipContactIdentity } from './contactIdentity';
import { answerSecondCallTransaction } from './secondCallAnswer';
import { answerSession, completeBlindTransfer, setSessionHeld } from './sessionControl';
import { syncLocalConference } from '../api/conference';

interface WebSessionDescriptionHandler {
  peerConnection?: RTCPeerConnection;
}

export interface AudioDeviceSettings {
  inputDeviceId?: string;
  outputDeviceId?: string;
  volume?: number;
}

type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type SinkSelectableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

interface RemoteAudioGraph {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  stream: MediaStream;
}

interface ConferenceEndpoint extends ConferenceAudioEndpoint<MediaStreamTrack> {
  sender: RTCRtpSender;
}

interface ConferenceTrackReplacement {
  sender: RTCRtpSender;
  originalTrack: MediaStreamTrack;
  mixedTrack: MediaStreamTrack;
}

interface LocalConferenceAudio {
  context: AudioContext;
  sources: MediaStreamAudioSourceNode[];
  destinations: MediaStreamAudioDestinationNode[];
  replacements: ConferenceTrackReplacement[];
  sessionIds: string[];
  blocked: boolean;
}

const REGISTER_FINAL_TIMEOUT_MS = 40_000;

class RegisterFinalResponseError extends Error {}
class RegisterAttemptCancelledError extends Error {}

interface PendingRegisterAttempt {
  registerer: Registerer;
  promise: Promise<void>;
  cancel: () => void;
}

function isRequestPendingError(error: unknown): boolean {
  return error instanceof Error && error.constructor.name === 'RequestPendingError';
}

export class SipClient {
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private sessions: Map<string, Session> = new Map();
  private remoteAudioElements: Map<string, HTMLAudioElement> = new Map();
  private remoteAudioGraphs: Map<string, RemoteAudioGraph> = new Map();
  private remoteTrackListeners: Map<string, { pc: RTCPeerConnection; listener: (event: RTCTrackEvent) => void }> = new Map();
  private localConferenceAudio: LocalConferenceAudio | null = null;
  private localConferenceGeneration = 0;
  private conferenceCallIds: string[] | null = null;
  private pendingSessionControls = new Set<string>();
  private conferenceMutationPending = false;
  private isolatedMicrophones = new Map<string, { track: MediaStreamTrack; enabled: boolean }>();
  private activeSessionId: string | null = null;
  private config: SipConfig;
  private audioDevices: AudioDeviceSettings;
  private sessionCounter = 0;
  private disconnecting = false;
  private reconnectRegistrationGate = new ReconnectRegistrationGate();
  private registrationRecovery: RegistrationRecoveryScheduler;
  private pendingRegisterAttempt: PendingRegisterAttempt | null = null;

  public onRegistered: (() => void) | null = null;
  public onUnregistered: (() => void) | null = null;
  public onIncomingCall: ((invitation: Invitation) => void) | null = null;
  public onCallEstablished: ((sessionId: string) => void) | null = null;
  public onCallEnded: ((sessionId: string) => void) | null = null;
  public onSecondIncomingCall: ((invitation: Invitation) => void) | null = null;
  public onConferenceMerged: (() => void) | null = null;

  constructor(config: SipConfig, audioDevices: AudioDeviceSettings = {}) {
    this.config = config;
    this.audioDevices = this.normalizeAudioDevices(audioDevices);
    this.registrationRecovery = new RegistrationRecoveryScheduler(() => this.performRegistrationRecovery());
  }

  private get sipDomain(): string {
    return normalizeSipHost(this.config.sipDomain || this.config.sipServer);
  }

  private normalizeDialTarget(target: string): string {
    const trimmed = target.trim();
    if (trimmed.toLowerCase().startsWith('sip:')) return trimmed;
    if (trimmed.includes('@')) return trimmed.replace(/\s+/g, '');
    return trimmed.replace(/[\s().-]/g, '');
  }

  private makeSipUri(target: string) {
    const trimmed = this.normalizeDialTarget(target);
    const uri = trimmed.toLowerCase().startsWith('sip:')
      ? trimmed
      : trimmed.includes('@')
        ? `sip:${trimmed}`
        : `sip:${trimmed}@${this.sipDomain}`;

    return UserAgent.makeURI(uri);
  }

  private buildIceServers(): RTCIceServer[] {
    const iceServers = resolveIceServers(this.config);
    if (iceServers.length === 1 && /^stuns?:/i.test(String(iceServers[0].urls))) {
      console.info('TURN credentials are empty; using STUN only for this call.');
    }
    return iceServers;
  }

  private normalizeAudioDevices(audioDevices: AudioDeviceSettings): AudioDeviceSettings {
    const volume = Number.isFinite(Number(audioDevices.volume))
      ? Math.max(0, Math.min(Number(audioDevices.volume), 100))
      : 80;
    return {
      inputDeviceId: audioDevices.inputDeviceId || 'default',
      outputDeviceId: audioDevices.outputDeviceId || 'default',
      volume,
    };
  }

  private isElectronRuntime(): boolean {
    return Boolean(window.electronAPI?.isElectron);
  }

  private desiredSinkId(): string {
    return this.audioDevices.outputDeviceId && this.audioDevices.outputDeviceId !== 'default'
      ? this.audioDevices.outputDeviceId
      : '';
  }

  private desiredVolume(): number {
    const volume = Number(this.audioDevices.volume ?? 80);
    return Math.max(0, Math.min(volume, 100)) / 100;
  }

  private logAudioEvent(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    const consoleMethod = level === 'warn' ? console.warn : level === 'error' ? console.error : console.info;
    consoleMethod(message, data ?? {});
    void window.electronAPI?.logRenderer?.(level, message, data).catch(() => {});
  }

  private async applyAudioContextSink(context: AudioContext): Promise<boolean> {
    const contextWithSink = context as SinkSelectableAudioContext;
    const desiredSink = this.desiredSinkId();
    if (!canUseDirectAudioPath(desiredSink, typeof contextWithSink.setSinkId === 'function')) {
      return false;
    }
    if (!desiredSink) return true;

    try {
      await contextWithSink.setSinkId!(desiredSink);
      return true;
    } catch (error) {
      this.logAudioEvent('warn', 'Unable to apply selected output device to desktop failsafe audio path; keeping the sink-selectable audio element.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private updateRemoteAudioGraphVolumes(): void {
    const volume = this.desiredVolume();
    for (const graph of this.remoteAudioGraphs.values()) {
      graph.gain.gain.value = volume;
      void this.applyAudioContextSink(graph.context);
    }
  }

  private mediaConstraints(): MediaStreamConstraints {
    const inputDeviceId = this.audioDevices.inputDeviceId;
    return {
      audio: inputDeviceId && inputDeviceId !== 'default'
        ? { deviceId: { exact: inputDeviceId } }
        : true,
      video: false,
    };
  }

  private sessionDescriptionHandlerOptions(): { constraints: MediaStreamConstraints } {
    return {
      constraints: this.mediaConstraints(),
    };
  }

  private async applyAudioElementSettings(audio: HTMLAudioElement): Promise<void> {
    audio.defaultMuted = false;
    audio.muted = false;
    audio.volume = this.desiredVolume();

    const audioWithSink = audio as SinkSelectableAudio;
    if (audioWithSink.setSinkId) {
      try {
        await audioWithSink.setSinkId(this.desiredSinkId());
      } catch (error) {
        console.warn('Unable to apply selected audio output device; using system default:', error);
      }
    }
  }

  updateAudioDevices(audioDevices: AudioDeviceSettings): void {
    this.audioDevices = this.normalizeAudioDevices(audioDevices);
    this.updateRemoteAudioGraphVolumes();
    for (const audio of this.remoteAudioElements.values()) {
      const sessionId = audio.dataset.skyevoxRemoteAudio;
      if (!sessionId) continue;
      void this.ensureRemoteAudioPlayback(sessionId, audio).catch((error) => {
        console.warn('Unable to update remote call audio output device:', error);
      });
    }
  }

  private generateSessionId(): string {
    this.sessionCounter++;
    return `session-${Date.now()}-${this.sessionCounter}`;
  }

  private webSessionDescriptionHandler(session: Session): WebSessionDescriptionHandler | null {
    return session.sessionDescriptionHandler
      ? session.sessionDescriptionHandler as unknown as WebSessionDescriptionHandler
      : null;
  }

  get currentSession(): Session | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  get hasActiveCall(): boolean {
    return this.activeSessionId !== null && this.sessions.has(this.activeSessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get conferenceActive(): boolean {
    return this.localConferenceAudio !== null;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getEstablishedParticipants(): Array<{ id: string; name: string; number: string }> {
    return Array.from(this.sessions.entries())
      .filter(([, session]) => session.state === SessionState.Established)
      .map(([id, session]) => ({
        id,
        name: session.remoteIdentity.displayName || '',
        number: session.remoteIdentity.uri.user || '',
      }));
  }

  getPeerConnection(sessionId?: string): RTCPeerConnection | null {
    const sid = sessionId ?? this.activeSessionId;
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    const sdh = this.webSessionDescriptionHandler(session);
    if (!sdh) return null;
    return sdh.peerConnection ?? null;
  }

  getHeldSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, session] of this.sessions) {
      if (id !== this.activeSessionId && session.state === SessionState.Established) {
        ids.push(id);
      }
    }
    return ids;
  }

  private createRegisterer(userAgent: UserAgent): Registerer {
    const registerer = new Registerer(userAgent, {
      expires: this.config.registerInterval,
      regId: 1,
    });
    registerer.stateChange.addListener((state: RegistererState) => {
      if (state === RegistererState.Registered) {
        if (this.disconnecting) return;
        this.registrationRecovery.registered();
        this.onRegistered?.();
      } else if (state === RegistererState.Unregistered) {
        if (this.disconnecting) return;
        this.onUnregistered?.();
        this.registrationRecovery.unexpectedUnregistered();
      }
    });
    return registerer;
  }


  private registerAndWait(registerer: Registerer): Promise<void> {
    const existing = this.pendingRegisterAttempt;
    if (existing) {
      if (existing.registerer === registerer) return existing.promise;
      return Promise.reject(new Error('Another SIP registerer is awaiting a final response.'));
    }

    const initialState = registerer.state;
    const outcome = new RegistrationFinalResponse();
    let dispatched = false;
    const onStateChange = (state: RegistererState) => {
      if (state === RegistererState.Registered) {
        finish();
      } else if (state === RegistererState.Terminated) {
        finish(new RegisterFinalResponseError('SIP registerer terminated before registration completed.'));
      } else if (dispatched && state === RegistererState.Unregistered && initialState !== RegistererState.Unregistered) {
        finish(new RegisterFinalResponseError('SIP REGISTER ended in the unregistered state.'));
      }
    };
    const timeout = window.setTimeout(() => {
      finish(new Error('SIP REGISTER final response timed out.'));
    }, REGISTER_FINAL_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (!outcome.complete(error)) return;
      window.clearTimeout(timeout);
      registerer.stateChange.removeListener(onStateChange);
    };
    registerer.stateChange.addListener(onStateChange);
    const cancel = () => finish(new RegisterAttemptCancelledError('SIP REGISTER recovery cancelled.'));
    dispatched = true;
    void registerer.register({
      requestDelegate: {
        onAccept: (response) => {
          if (registerer.state === RegistererState.Registered) finish();
          else finish(new RegisterFinalResponseError(`SIP REGISTER ${response.message.statusCode} did not establish registration.`));
        },
        onRedirect: (response) => {
          finish(new RegisterFinalResponseError(`SIP REGISTER redirected with ${response.message.statusCode}.`));
        },
        onReject: (response) => {
          finish(new RegisterFinalResponseError(`SIP REGISTER rejected with ${response.message.statusCode}.`));
        },
      },
    }).catch((error: unknown) => {
      if (isRequestPendingError(error) && registerer.state === RegistererState.Registered) {
        finish();
        return;
      }
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    const attempt: PendingRegisterAttempt = { registerer, promise: outcome.promise, cancel };
    this.pendingRegisterAttempt = attempt;
    const clear = () => {
      if (this.pendingRegisterAttempt === attempt) this.pendingRegisterAttempt = null;
    };
    void outcome.promise.then(clear, clear);
    return outcome.promise;
  }

  private cancelPendingRegisterAttempt(): boolean {
    const pending = this.pendingRegisterAttempt;
    if (!pending) return false;
    pending.cancel();
    return true;
  }
  private async rebuildRegistrationAfterReconnect(): Promise<boolean> {
    const userAgent = this.ua;
    const previousRegisterer = this.registerer;
    if (!userAgent || this.disconnecting) return false;

    if (previousRegisterer) {
      try {
        await previousRegisterer.unregister();
      } catch (error) {
        console.warn('Unable to unregister stale SIP contact after transport recovery:', error);
      }
      try {
        await previousRegisterer.dispose();
      } catch (error) {
        console.warn('Unable to dispose stale SIP registerer after transport recovery:', error);
      }
    }

    if (this.disconnecting || this.ua !== userAgent) return false;
    const registerer = this.createRegisterer(userAgent);
    this.registerer = registerer;
    try {
      await this.registerAndWait(registerer);
      return true;
    } catch (error) {
      console.error('SIP re-registration after transport recovery failed:', error);
      if (!this.disconnecting) this.onUnregistered?.();
      return false;
    }
  }

  async connect(): Promise<void> {
    this.disconnecting = false;
    this.reconnectRegistrationGate.reset();
    const username = normalizeSipUser(this.config.username);
    const sipDomain = this.sipDomain;
    const uri = UserAgent.makeURI(`sip:${username}@${sipDomain}`);
    if (!uri) throw new Error(`Failed to create SIP URI for ${username || '(blank)'}@${sipDomain || '(blank)'}`);
    const contactIdentity = loadSipContactIdentity(username, sipDomain);

    this.ua = new UserAgent({
      ...SIP_RECONNECT_OPTIONS,
      uri,
      transportOptions: {
        server: this.config.wssUrl,
        keepAliveInterval: 25,
        keepAliveDebounce: 10,
      },
      authorizationUsername: username,
      authorizationPassword: this.config.password,
      displayName: this.config.displayName,
      contactName: contactIdentity.contactName,
      instanceId: contactIdentity.instanceId,
      viaHost: contactIdentity.viaHost,
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: {
          iceServers: this.buildIceServers(),
        },
      },
    });

    this.ua.delegate = {
      onConnect: () => {
        if (!this.reconnectRegistrationGate.consumeReconnect()) return;
        void this.registrationRecovery.recoverNow().catch((error) => {
          console.warn('SIP registration recovery after transport reconnect failed:', error);
        });
      },
      onDisconnect: (error?: Error) => {
        if (this.disconnecting || !error) return;
        this.reconnectRegistrationGate.markDisconnected();
        this.onUnregistered?.();
        this.registrationRecovery.unexpectedUnregistered();
      },
      onInvite: (invitation: Invitation) => {
        // If we already have an active call, this is a second incoming call (call waiting)
        if (this.hasActiveCall) {
          const sessionId = this.generateSessionId();
          this.sessions.set(sessionId, invitation);
          this.setupSessionListeners(invitation, sessionId);
          this.onSecondIncomingCall?.(invitation);
        } else {
          const sessionId = this.generateSessionId();
          this.sessions.set(sessionId, invitation);
          this.activeSessionId = sessionId;
          this.setupSessionListeners(invitation, sessionId);
          this.onIncomingCall?.(invitation);
        }
      },
    };
    this.registrationRecovery.start();

    await this.ua.start();

    this.registerer = this.createRegisterer(this.ua);

    try {
      await this.registerAndWait(this.registerer);
    } catch (error) {
      if (!this.disconnecting) {
        this.onUnregistered?.();
        this.registrationRecovery.unexpectedUnregistered();
      }
      throw error;
    }
  }

  async recoverRegistration(): Promise<void> {
    return this.registrationRecovery.recoverNow();
  }

  private async performRegistrationRecovery(): Promise<void> {
    if (this.disconnecting || !this.ua) {
      throw new Error('SIP client is not available for recovery.');
    }
    if (!this.registerer) {
      await this.ua.reconnect();
      if (!await this.rebuildRegistrationAfterReconnect()) {
        throw new Error('SIP registration recovery failed.');
      }
      return;
    }
    try {
      await this.registerAndWait(this.registerer);
    } catch (error) {
      if (error instanceof RegisterFinalResponseError || error instanceof RegisterAttemptCancelledError || isRequestPendingError(error)) {
        throw error;
      }
      console.warn('SIP REGISTER transport failed; rebuilding transport registration:', error);
      if (this.disconnecting) throw new Error('SIP client is disconnecting.');
      this.reconnectRegistrationGate.reset();
      await this.ua.reconnect();
      if (!await this.rebuildRegistrationAfterReconnect()) {
        throw new Error('SIP registration recovery failed.');
      }
    }
  }

  async call(target: string): Promise<string> {
    if (!this.ua) throw new Error('Not connected');

    const targetUri = this.makeSipUri(target);
    if (!targetUri) throw new Error(`Invalid target: ${target}`);

    console.info('Starting SIP INVITE', { target: targetUri.toString() });
    const inviter = new Inviter(this.ua, targetUri, {
      sessionDescriptionHandlerOptions: this.sessionDescriptionHandlerOptions(),
    });
    const sessionId = this.generateSessionId();
    this.sessions.set(sessionId, inviter);
    this.activeSessionId = sessionId;
    this.setupSessionListeners(inviter, sessionId);
    try {
      await inviter.invite();
    } catch (error) {
      this.sessions.delete(sessionId);
      if (this.activeSessionId === sessionId) this.activeSessionId = null;
      throw error;
    }
    return sessionId;
  }

  async answer(sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.activeSessionId;
    if (!sid) return;
    const session = this.sessions.get(sid);
    if (!session || !('accept' in session)) return;
    await answerSession(session as Invitation, {
      sessionDescriptionHandlerOptions: this.sessionDescriptionHandlerOptions(),
    });
  }

  async hangup(sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.activeSessionId;
    if (!sid) return;
    const session = this.sessions.get(sid);
    if (!session) return;

    const state = session.state;
    if (state === SessionState.Established) {
      await session.bye();
    } else if (state === SessionState.Establishing || state === SessionState.Initial) {
      if ('cancel' in session) {
        await (session as Inviter).cancel();
      } else if ('reject' in session) {
        await (session as Invitation).reject();
      }
    }
  }

  async hold(sessionId?: string): Promise<void> {
    await this.changeHold(true, sessionId);
  }

  async unhold(sessionId?: string): Promise<void> {
    await this.changeHold(false, sessionId);
  }

  private async changeHold(held: boolean, sessionId?: string): Promise<void> {
    if (this.disconnecting) throw new Error('SIP client is disconnecting.');
    if (this.conferenceMutationPending) throw new Error('Conference media is being changed. Try again when it completes.');
    const conference = sessionId === undefined ? this.localConferenceAudio : null;
    const ids = conference?.sessionIds ?? [sessionId ?? this.activeSessionId];
    const participants = ids.map((id) => {
      if (!id) throw new Error('No active call to change hold state.');
      const session = this.sessions.get(id);
      if (!session || session.state !== SessionState.Established) {
        throw new Error('A call is no longer available for hold or resume.');
      }
      if (this.pendingSessionControls.has(id)) throw new Error('Hold or resume is already in progress.');
      return { id, session, wasHeld: session.sessionDescriptionHandlerModifiersReInvite.includes(Web.holdModifier) };
    });
    participants.forEach(({ id }) => this.pendingSessionControls.add(id));
    const wasBlocked = conference?.blocked ?? false;
    if (conference) this.blockConferenceAudio(conference, true);
    try {
      if (!conference) {
        const { id, session } = participants[0];
        await setSessionHeld(session, held);
        if (!held) this.restoreIsolatedMicrophone(id);
        return;
      }
      // Every dialog negotiates independently. Do not reopen mixed RTP until all
      // accepted answers have been applied, including during compensation.
      const results = await Promise.allSettled(participants.map(({ session }) => setSessionHeld(session, held)));
      const current = () => this.localConferenceAudio === conference && !this.disconnecting &&
        participants.every(({ id, session }) => this.sessions.get(id) === session && session.state === SessionState.Established);
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (!current()) failures.push(new Error('Conference membership changed during hold or resume.'));
      if (failures.length === 0) {
        this.blockConferenceAudio(conference, held);
        return;
      }
      const rollback = await Promise.allSettled(participants.map(async ({ session, wasHeld }, index) => {
        if (results[index].status === 'fulfilled' && wasHeld !== held) {
          await setSessionHeld(session, wasHeld);
        }
      }));
      const rollbackFailures = rollback.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      const restored = current() && rollbackFailures.length === 0;
      if (restored) this.blockConferenceAudio(conference, wasBlocked);
      throw new AggregateError([...failures, ...rollbackFailures],
        restored
          ? `Conference ${held ? 'hold' : 'resume'} failed; the previous state was restored.`
          : 'Conference hold state is incomplete; outbound audio remains isolated. Retry the control or end the calls.');
    } finally {
      participants.forEach(({ id }) => this.pendingSessionControls.delete(id));
    }
  }

  private blockConferenceAudio(conference: LocalConferenceAudio, blocked: boolean): void {
    conference.blocked = blocked;
    conference.replacements.forEach(({ mixedTrack }) => { mixedTrack.enabled = !blocked; });
  }

  private restoreIsolatedMicrophone(sessionId: string): void {
    const isolated = this.isolatedMicrophones.get(sessionId);
    if (!isolated) return;
    isolated.track.enabled = isolated.enabled;
    this.isolatedMicrophones.delete(sessionId);
  }

  toggleMute(sessionId?: string): boolean {
    const sid = sessionId ?? this.activeSessionId;
    if (!sid) return false;
    const session = this.sessions.get(sid);
    if (!session || session.state !== SessionState.Established) return false;
    const isolated = this.isolatedMicrophones.get(sid);
    if (isolated) {
      isolated.enabled = !isolated.enabled;
      return !isolated.enabled;
    }
    const sdh = this.webSessionDescriptionHandler(session);
    if (!sdh) return false;

    const pc = sdh.peerConnection;
    if (!pc) return false;

    const audioSender = pc.getSenders().find((s: RTCRtpSender) => s.track?.kind === 'audio');
    if (!audioSender?.track) return false;
    if (this.localConferenceAudio) {
      const localTracks = this.localConferenceAudio.replacements.map((replacement) => replacement.originalTrack);
      const mute = localTracks.some((track) => track.enabled);
      localTracks.forEach((track) => {
        track.enabled = !mute;
      });
      return mute;
    }
    audioSender.track.enabled = !audioSender.track.enabled;
    return !audioSender.track.enabled;
  }

  sendDTMF(digit: string, sessionId?: string): void {
    const sid = sessionId ?? this.activeSessionId;
    if (!sid) return;
    const session = this.sessions.get(sid);
    if (!session || session.state !== SessionState.Established) return;

    const sdh = this.webSessionDescriptionHandler(session);
    if (!sdh) return;

    const pc = sdh.peerConnection;
    if (!pc) return;

    const senders = pc.getSenders();
    const audioSender = senders.find((s: RTCRtpSender) => s.track?.kind === 'audio');
    if (audioSender) {
      const dtmfSender = audioSender.dtmf;
      if (dtmfSender) {
        dtmfSender.insertDTMF(digit, 100, 70);
      }
    }
  }

  async transfer(target: string, sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.activeSessionId;
    if (!sid) throw new Error('No active call to transfer.');
    const session = this.sessions.get(sid);
    if (!session) throw new Error('The active call is no longer available.');
    const targetUri = this.makeSipUri(target);
    if (!targetUri) throw new Error(`Invalid transfer target: ${target}`);
    await completeBlindTransfer(session, targetUri);
  }

  // Conference / 3-way calling methods

  async conferenceCall(target: string): Promise<string | null> {
    const primarySessionId = this.activeSessionId;
    if (!primarySessionId) return null;
    if (this.sessions.size !== 1) {
      throw new Error('Merge or end the other call before adding a participant.');
    }
    await this.hold(primarySessionId);
    try {
      return await this.call(target);
    } catch (error) {
      this.activeSessionId = primarySessionId;
      await this.unhold(primarySessionId).catch(() => {});
      throw error;
    }
  }

  private establishedConferenceEndpoints(): ConferenceEndpoint[] {
    const endpoints: ConferenceEndpoint[] = [];
    for (const [id, session] of this.sessions) {
      if (session.state !== SessionState.Established) continue;
      const peerConnection = this.webSessionDescriptionHandler(session)?.peerConnection;
      if (!peerConnection) {
        throw new Error(`Conference call ${id} has no peer connection.`);
      }
      const sender = peerConnection.getSenders().find((candidate) => candidate.track?.kind === 'audio');
      const localTrack = sender?.track;
      if (!sender || !localTrack) {
        throw new Error(`Conference call ${id} has no outbound audio track.`);
      }
      const remoteTracks = peerConnection.getReceivers()
        .map((receiver) => receiver.track)
        .filter((track) => track.kind === 'audio' && track.readyState === 'live');
      if (remoteTracks.length === 0) {
        throw new Error(`Conference call ${id} has no inbound audio track.`);
      }
      endpoints.push({ id, sender, localTrack, remoteTracks });
    }
    return endpoints;
  }

  private async stopLocalConferenceAudio(): Promise<void> {
    this.localConferenceGeneration++;
    const conference = this.localConferenceAudio;
    const callIds = this.conferenceCallIds;
    this.conferenceCallIds = null;
    if (!conference) {
      if (callIds) await syncLocalConference(this.config, callIds, false);
      return;
    }
    // Teardown must not bypass a held/pending/failed conference's privacy gate.
    conference.replacements.forEach((replacement, index) => {
      replacement.mixedTrack.enabled = false;
      if (conference.blocked) {
        const id = conference.sessionIds[index];
        if (this.sessions.has(id)) {
          this.isolatedMicrophones.set(id, { track: replacement.originalTrack, enabled: replacement.originalTrack.enabled });
        }
        replacement.originalTrack.enabled = false;
      }
    });
    this.localConferenceAudio = null;
    const restored = await Promise.allSettled(
      conference.replacements.map((replacement) => replacement.sender.replaceTrack(replacement.originalTrack)),
    );
    conference.sources.forEach((source) => source.disconnect());
    conference.destinations.forEach((destination) => {
      destination.stream.getTracks().forEach((track) => track.stop());
    });
    await conference.context.close().catch(() => {});
    if (callIds) await syncLocalConference(this.config, callIds, false);
    if (restored.some((result) => result.status === 'rejected')) {
      throw new Error('Unable to restore one or more call media tracks after conference.');
    }
  }

  private async startLocalConferenceAudio(): Promise<void> {
    await this.stopLocalConferenceAudio();
    const generation = ++this.localConferenceGeneration;
    const endpoints = this.establishedConferenceEndpoints();
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('Local conference audio is unavailable on this device.');
    }
    const context = new AudioContextCtor();
    const sources: MediaStreamAudioSourceNode[] = [];
    const destinations: MediaStreamAudioDestinationNode[] = [];
    const replacements: ConferenceTrackReplacement[] = [];
    const replaced: ConferenceTrackReplacement[] = [];
    try {
      if (context.state === 'suspended') await context.resume();
      for (const endpoint of endpoints) {
        const destination = context.createMediaStreamDestination();
        destinations.push(destination);
        for (const track of conferenceMixTracksFor(endpoints, endpoint.id)) {
          const source = context.createMediaStreamSource(new MediaStream([track]));
          source.connect(destination);
          sources.push(source);
        }
        const mixedTrack = destination.stream.getAudioTracks()[0];
        if (!mixedTrack) {
          throw new Error(`Conference call ${endpoint.id} produced no outbound audio track.`);
        }
        replacements.push({
          sender: endpoint.sender,
          originalTrack: endpoint.localTrack,
          mixedTrack,
        });
      }
      if (generation !== this.localConferenceGeneration ||
          endpoints.some((endpoint) => this.sessions.get(endpoint.id)?.state !== SessionState.Established)) {
        throw new Error('A conference participant ended while media was being connected.');
      }
      for (const replacement of replacements) {
        if (generation !== this.localConferenceGeneration) {
          throw new Error('Conference media setup was superseded.');
        }
        await replacement.sender.replaceTrack(replacement.mixedTrack);
        replaced.push(replacement);
      }
      if (generation !== this.localConferenceGeneration ||
          endpoints.some((endpoint) => this.sessions.get(endpoint.id)?.state !== SessionState.Established)) {
        throw new Error('A conference participant ended while media was being connected.');
      }
      this.localConferenceAudio = { context, sources, destinations, replacements, sessionIds: endpoints.map(({ id }) => id), blocked: false };
    } catch (error) {
      await Promise.allSettled(
        replaced.map((replacement) => replacement.sender.replaceTrack(replacement.originalTrack)),
      );
      sources.forEach((source) => source.disconnect());
      destinations.forEach((destination) => {
        destination.stream.getTracks().forEach((track) => track.stop());
      });
      await context.close().catch(() => {});
      throw error;
    }
  }

  async mergeCall(): Promise<void> {
    if (this.localConferenceAudio) return;
    if (this.conferenceMutationPending || this.pendingSessionControls.size) {
      throw new Error('Wait for the current hold or conference operation to complete.');
    }
    const sessions = Array.from(this.sessions.entries())
      .filter(([, session]) => session.state === SessionState.Established);
    if (sessions.length !== 2) {
      throw new Error('Wait for both calls to connect before merging.');
    }
    const callIds = sessions.map(([, session]) => session.dialog?.callId || '');
    if (callIds.some((id) => !id)) throw new Error('Conference SIP dialogs are not ready.');
    this.conferenceMutationPending = true;
    try {
      for (const [id, session] of sessions) {
        await setSessionHeld(session, false);
        this.restoreIsolatedMicrophone(id);
        this.setupRemoteAudio(session, id);
      }
      await this.startLocalConferenceAudio();
      await syncLocalConference(this.config, callIds, true);
      this.conferenceCallIds = callIds;
      if (sessions.some(([id]) => this.sessions.get(id)?.state !== SessionState.Established)) {
        await syncLocalConference(this.config, callIds, false);
        this.conferenceCallIds = null;
        throw new Error('A participant ended before the conference completed.');
      }
    } catch (error) {
      await this.stopLocalConferenceAudio().catch(() => {});
      for (const [id, session] of sessions) {
        if (id !== this.activeSessionId && session.state === SessionState.Established) {
          await setSessionHeld(session, true).catch(() => {});
        }
      }
      throw error;
    } finally {
      this.conferenceMutationPending = false;
    }
    this.onConferenceMerged?.();
  }

  async splitConference(): Promise<void> {
    if (this.conferenceMutationPending || this.pendingSessionControls.size) {
      throw new Error('Wait for the current hold or conference operation to complete.');
    }
    this.conferenceMutationPending = true;
    const ids = this.localConferenceAudio?.sessionIds ?? Array.from(this.sessions.keys());
    try {
      await this.stopLocalConferenceAudio();
      for (const id of ids) {
        const session = this.sessions.get(id);
        if (!session || session.state !== SessionState.Established || id === this.activeSessionId) continue;
        await setSessionHeld(session, true);
      }
    } finally {
      this.conferenceMutationPending = false;
    }
  }

  async dropParticipant(sessionId: string): Promise<void> {
    await this.hangup(sessionId);
  }

  // Call waiting: swap between active and held calls
  async swapCalls(): Promise<string | null> {
    const heldIds = this.getHeldSessionIds();
    if (heldIds.length === 0 || !this.activeSessionId) return null;

    const currentActiveId = this.activeSessionId;
    const targetId = heldIds[0];

    // Hold current
    await this.hold(currentActiveId);
    // Unhold target
    await this.unhold(targetId);
    this.activeSessionId = targetId;

    return targetId;
  }

  // Answer a second (waiting) call, putting current on hold
  async answerSecondCall(sessionId: string): Promise<void> {
    const previousSessionId = this.activeSessionId;
    this.activeSessionId = await answerSecondCallTransaction(previousSessionId, sessionId, {
      hold: (id) => this.hold(id),
      answer: (id) => this.answer(id),
      unhold: (id) => this.unhold(id),
      onRollbackError: (error) => {
        console.warn('Unable to restore the primary call after waiting-call answer failed:', error);
      },
    });
  }

  async rejectSecondCall(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && 'reject' in session) {
      await (session as Invitation).reject();
    }
    this.sessions.delete(sessionId);
  }

  // Find the session ID for a given Invitation object
  findSessionId(session: Session): string | null {
    for (const [id, s] of this.sessions) {
      if (s === session) return id;
    }
    return null;
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    const registerWasPending = this.cancelPendingRegisterAttempt();
    await this.registrationRecovery.stop();
    this.reconnectRegistrationGate.reset();
    await this.stopLocalConferenceAudio().catch((error) => {
      console.warn('Unable to stop local conference audio during shutdown:', error);
    });
    // Hang up all active sessions
    for (const [id] of this.sessions) {
      await this.hangup(id).catch(() => {});
    }
    this.sessions.clear();
    this.isolatedMicrophones.clear();
    for (const sessionId of Array.from(this.remoteAudioElements.keys())) {
      this.cleanupRemoteAudio(sessionId);
    }
    this.activeSessionId = null;

    try {
      if (this.registerer && !registerWasPending) await this.registerer.unregister();
    } catch (error) {
      console.warn('Unable to unregister SIP contact during shutdown:', error);
    } finally {
      if (this.ua) await this.ua.stop();
    }

  }

  private setupSessionListeners(session: Session, sessionId: string): void {
    session.stateChange.addListener((state: SessionState) => {
      switch (state) {
        case SessionState.Established:
          this.setupRemoteAudio(session, sessionId);
          this.onCallEstablished?.(sessionId);
          break;
        case SessionState.Terminated: {
          this.sessions.delete(sessionId);
          this.isolatedMicrophones.delete(sessionId);
          this.cleanupRemoteAudio(sessionId);
          if (this.activeSessionId === sessionId) {
            const remaining = Array.from(this.sessions.keys());
            this.activeSessionId = remaining.length > 0 ? remaining[0] : null;
          }
          const notifyEnded = async () => {
            if (!this.localConferenceAudio || this.localConferenceAudio.sessionIds.includes(sessionId)) {
              await this.stopLocalConferenceAudio().catch((error) => {
                console.warn('Unable to restore remaining call audio after conference participant ended:', error);
              });
            }
            this.onCallEnded?.(sessionId);
          };
          void notifyEnded();
          break;
        }
      }
    });
  }

  private async disposeRemoteAudioGraph(sessionId: string): Promise<void> {
    const graph = this.remoteAudioGraphs.get(sessionId);
    if (!graph) return;
    try {
      graph.source.disconnect();
      graph.gain.disconnect();
    } catch {
      // Already disconnected.
    }
    await graph.context.close().catch(() => {});
    this.remoteAudioGraphs.delete(sessionId);
  }

  private cleanupRemoteAudio(sessionId: string): void {
    const trackListener = this.remoteTrackListeners.get(sessionId);
    if (trackListener) {
      trackListener.pc.removeEventListener('track', trackListener.listener);
      this.remoteTrackListeners.delete(sessionId);
    }


    void this.disposeRemoteAudioGraph(sessionId);

    const audio = this.remoteAudioElements.get(sessionId);
    if (!audio) return;
    audio.pause();
    const stream = audio.srcObject;
    if (stream instanceof MediaStream) {
      stream.getTracks().forEach((track) => stream.removeTrack(track));
    }
    audio.srcObject = null;
    audio.remove();
    this.remoteAudioElements.delete(sessionId);
  }

  private async ensureDirectRemoteAudioPlayback(sessionId: string, audio: HTMLAudioElement): Promise<boolean> {
    if (!this.isElectronRuntime()) return false;
    const stream = this.getRemoteStream(audio);
    if (stream.getAudioTracks().length === 0) return false;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return false;
    const contextPrototype = AudioContextCtor.prototype as SinkSelectableAudioContext;
    if (!canUseDirectAudioPath(this.desiredSinkId(), typeof contextPrototype.setSinkId === 'function')) {
      await this.disposeRemoteAudioGraph(sessionId);
      return false;
    }

    let graph = this.remoteAudioGraphs.get(sessionId);
    if (!graph || graph.stream !== stream || graph.context.state === 'closed') {
      if (graph) await this.disposeRemoteAudioGraph(sessionId);

      const context = new AudioContextCtor() as AudioContext;
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      gain.gain.value = this.desiredVolume();
      source.connect(gain);
      gain.connect(context.destination);
      graph = { context, source, gain, stream };
      this.remoteAudioGraphs.set(sessionId, graph);
      this.logAudioEvent('info', 'Started desktop failsafe remote audio path.', {
        sessionId,
        trackCount: stream.getAudioTracks().length,
        outputDevice: this.audioDevices.outputDeviceId || 'default',
      });
    }

    graph.gain.gain.value = this.desiredVolume();
    if (!await this.applyAudioContextSink(graph.context)) {
      await this.disposeRemoteAudioGraph(sessionId);
      return false;
    }
    if (graph.context.state === 'suspended') {
      try {
        await graph.context.resume();
      } catch (error) {
        this.logAudioEvent('warn', 'Unable to resume desktop failsafe audio context.', {
          sessionId,
          state: graph.context.state,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    return graph.context.state === 'running';
  }


  private getOrCreateRemoteAudio(sessionId: string): HTMLAudioElement {
    const existing = this.remoteAudioElements.get(sessionId);
    if (existing) return existing;

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = false;
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audio.controls = false;
    audio.style.display = 'none';
    audio.dataset.skyevoxRemoteAudio = sessionId;
    document.body.appendChild(audio);
    this.remoteAudioElements.set(sessionId, audio);
    return audio;
  }

  private getRemoteStream(audio: HTMLAudioElement): MediaStream {
    if (audio.srcObject instanceof MediaStream) {
      return audio.srcObject;
    }

    const stream = new MediaStream();
    audio.srcObject = stream;
    return stream;
  }

  private addRemoteAudioTrack(sessionId: string, audio: HTMLAudioElement, track: MediaStreamTrack): void {
    if (track.kind !== 'audio') return;

    const stream = this.getRemoteStream(audio);
    if (!stream.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
      stream.addTrack(track);
      this.logAudioEvent('info', 'Remote audio track attached.', {
        sessionId,
        trackId: track.id,
        muted: track.muted,
        readyState: track.readyState,
      });
    }

    track.addEventListener('unmute', () => {
      void this.ensureRemoteAudioPlayback(sessionId, audio);
    }, { once: true });

    void this.ensureRemoteAudioPlayback(sessionId, audio);
  }

  private async ensureRemoteAudioPlayback(sessionId: string, audio: HTMLAudioElement): Promise<void> {
    await this.applyAudioElementSettings(audio);
    const directAudioStarted = await this.ensureDirectRemoteAudioPlayback(sessionId, audio);
    if (directAudioStarted) {
      // Electron's hidden audio element can report playing while remaining silent on some systems.
      // Keep the element alive for WebRTC, but let the direct WebAudio graph render the sound.
      audio.volume = 0;
    }

    try {
      await audio.play();
      this.logAudioEvent('info', 'Remote audio element started.', {
        sessionId,
        sinkId: this.desiredSinkId() || 'default',
        directAudioStarted,
        trackCount: audio.srcObject instanceof MediaStream ? audio.srcObject.getAudioTracks().length : 0,
      });
      return;
    } catch (error) {
      const selectedOutput = this.audioDevices.outputDeviceId && this.audioDevices.outputDeviceId !== 'default';
      const audioWithSink = audio as SinkSelectableAudio;
      if (selectedOutput && audioWithSink.setSinkId) {
        try {
          await audioWithSink.setSinkId('');
          await audio.play();
          this.logAudioEvent('warn', 'Selected audio output failed; remote call audio element is playing through system default.', {
            sessionId,
            directAudioStarted,
          });
          return;
        } catch {
          // Preserve the original play error below.
        }
      }

      this.logAudioEvent(directAudioStarted ? 'warn' : 'error', 'Unable to start remote call audio element.', {
        sessionId,
        directAudioStarted,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setupRemoteAudio(session: Session, sessionId: string): void {
    const sdh = this.webSessionDescriptionHandler(session);
    if (!sdh) return;

    const pc = sdh.peerConnection;
    if (!pc) return;

    const remoteAudio = this.getOrCreateRemoteAudio(sessionId);
    const addTrack = (track: MediaStreamTrack | null) => {
      if (track) this.addRemoteAudioTrack(sessionId, remoteAudio, track);
    };

    pc.getReceivers().forEach((receiver: RTCRtpReceiver) => addTrack(receiver.track));

    if (!this.remoteTrackListeners.has(sessionId)) {
      const listener = (event: RTCTrackEvent) => {
        addTrack(event.track);
        event.streams.forEach((stream) => stream.getAudioTracks().forEach(addTrack));
      };
      pc.addEventListener('track', listener);
      this.remoteTrackListeners.set(sessionId, { pc, listener });
    }

    void this.ensureRemoteAudioPlayback(sessionId, remoteAudio);
  }
}
