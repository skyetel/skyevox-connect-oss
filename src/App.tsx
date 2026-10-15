import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { useStore } from './store/useStore';
import { SipClient, type AudioDeviceSettings } from './sip/SipClient';
import { NativeSipClient, type NativeInvitation } from './sip/NativeSipClient';
import { Dialpad } from './components/Dialpad';
import { CallControls } from './components/CallControls';
import { IncomingCall } from './components/IncomingCall';
import { CallHistory } from './components/CallHistory';
import { Directory } from './components/Directory';
import { Settings } from './components/Settings';
import { unregisterMobileDevice } from './api/mobile';
import { Voicemail } from './components/Voicemail';
import { Messages } from './components/Messages';
import { CallWaiting } from './components/CallWaiting';
import { QRScanner } from './components/QRScanner';
import { InputModal } from './components/InputModal';
import { ScreenPop } from './components/ScreenPop';
import { UpdateBanner } from './components/UpdateBanner';
import { Supervisor } from './components/Supervisor';
import { apiUrl, apiUrlForConfig, isNative, isElectron, provisioningUrl } from './platform';
import { platformUsesLocalRingtone, platformUsesNativeEngine } from './nativeEnginePolicy';
import { Storage } from './storage';
import { DEFAULT_MANUAL_CONFIG, normalizeSipConfig, sipConfigFromProvisioning } from './config';
import { CallWaitingLifecycle } from './callWaitingLifecycle';
import { installEmbeddedFetchContext, isEmbeddedWebPhone, loadEmbeddedSipConfig } from './embedded';
import { voicemailApiHeaders, voicemailApiUrl } from './api/voicemail';
import { claimPendingBrowserCalls, disableBrowserPush, startBrowserPushHeartbeat } from './api/push';
import { fetchSupervisorCapabilities } from './api/supervisor';
import { fetchDndState } from './api/dnd';
import { directoryExtensions, fetchDirectory } from './api/directory';
import { handleDeepLink } from './deepLink';
import { useBackgroundAudio } from './hooks/useBackgroundAudio';
import { useAppLifecycle } from './hooks/useAppLifecycle';
import { useAnnouncer } from './hooks/useAnnouncer';
import { useKeyboardNav } from './hooks/useKeyboardNav';
import { qualityAverages, useCallQuality } from './hooks/useCallQuality';
import { useScreenPop } from './hooks/useScreenPop';
import { useAutoUpdate } from './hooks/useAutoUpdate';
import { useNativeMobileRegistration } from './hooks/useNativeMobileRegistration';
import type { Invitation } from 'sip.js';
import type { CallHistoryEntry, SipConfig, SupervisorCapabilities } from './types';
import { usesActiveCallControls } from './callState';
import { IncomingCallAlertCoordinator } from './audio/ringtone';

declare const __APP_VERSION__: string;

const CALL_HISTORY_STORAGE_KEY = 'skyevox_call_history';
const AUDIO_SETTINGS_STORAGE_KEY = 'skyevox_audio_settings';
type IncomingCallLike = Invitation | NativeInvitation;
type SoftphoneClient = SipClient | NativeSipClient;

interface StoredAudioSettings extends AudioDeviceSettings {
  ringtone?: string;
}

function normalizeStoredCallHistory(value: string | null): CallHistoryEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        id: String(entry.id || Date.now()),
        direction: ['inbound', 'outbound', 'missed'].includes(entry.direction) ? entry.direction : 'outbound',
        remoteNumber: String(entry.remoteNumber || ''),
        remoteName: String(entry.remoteName || ''),
        timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
        duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : 0,
        qualityMetrics: entry.qualityMetrics,
      }))
      .filter((entry) => entry.remoteNumber)
      .slice(0, 100);
  } catch {
    return [];
  }
}

function mergeCallHistory(primary: CallHistoryEntry[], secondary: CallHistoryEntry[]): CallHistoryEntry[] {
  const seen = new Set<string>();
  return [...primary, ...secondary]
    .filter((entry) => {
      const key = `${entry.direction}|${entry.remoteNumber}|${new Date(entry.timestamp).toISOString()}|${entry.duration}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 100);
}

function normalizeStoredAudioSettings(value: string | null): StoredAudioSettings {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return {};
    const volume = Number(parsed.volume);
    return {
      inputDeviceId: typeof parsed.inputDeviceId === 'string' && parsed.inputDeviceId ? parsed.inputDeviceId : undefined,
      outputDeviceId: typeof parsed.outputDeviceId === 'string' && parsed.outputDeviceId ? parsed.outputDeviceId : undefined,
      ringtone: typeof parsed.ringtone === 'string' && parsed.ringtone ? parsed.ringtone : undefined,
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(volume, 100)) : undefined,
    };
  } catch {
    return {};
  }
}

interface ManualSetupModalProps {
  onClose: () => void;
  onSave: (config: SipConfig) => void;
  initialConfig?: SipConfig | null;
}

function ManualSetupModal({ onClose, onSave, initialConfig }: ManualSetupModalProps) {
  const normalizedInitial = initialConfig ? normalizeSipConfig(initialConfig) : null;
  const [username, setUsername] = useState(normalizedInitial?.username || '');
  const [password, setPassword] = useState(normalizedInitial?.password || '');
  const [extension, setExtension] = useState(normalizedInitial?.extension || '');
  const [displayName, setDisplayName] = useState(normalizedInitial?.displayName || '');
  const [sipDomain, setSipDomain] = useState(normalizedInitial?.sipDomain || normalizedInitial?.sipServer || '');
  const [sipServer, setSipServer] = useState(normalizedInitial?.sipServer || DEFAULT_MANUAL_CONFIG.sipServer);
  const [wssUrl, setWssUrl] = useState(normalizedInitial?.wssUrl || DEFAULT_MANUAL_CONFIG.wssUrl);
  const [turnServer, setTurnServer] = useState(normalizedInitial?.turnServer || DEFAULT_MANUAL_CONFIG.turnServer);
  const [turnUsername, setTurnUsername] = useState(normalizedInitial?.turnCredentials.username || '');
  const [turnCredential, setTurnCredential] = useState(normalizedInitial?.turnCredentials.credential || '');
  const [error, setError] = useState('');
  const editing = !!initialConfig;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let cleanUsername = username.trim();
    let cleanSipDomain = sipDomain.trim();
    const cleanWssUrl = wssUrl.trim();

    if (cleanUsername.includes('@')) {
      const [userPart, domainPart] = cleanUsername.split('@');
      cleanUsername = userPart;
      cleanSipDomain = cleanSipDomain || domainPart;
    }

    const cleanExtension = extension.trim() || cleanUsername;

    if (!cleanUsername) {
      setError('Enter the extension or SIP username.');
      return;
    }
    if (!password) {
      setError('Enter the SIP password.');
      return;
    }
    if (!cleanWssUrl.toLowerCase().startsWith('wss://')) {
      setError('The WebSocket URL must start with wss://.');
      return;
    }

    onSave(normalizeSipConfig({
      sipDomain: cleanSipDomain || sipServer.trim() || DEFAULT_MANUAL_CONFIG.sipServer,
      sipServer: sipServer.trim() || DEFAULT_MANUAL_CONFIG.sipServer,
      wssUrl: cleanWssUrl,
      username: cleanUsername,
      password,
      displayName: displayName.trim() || `Ext ${cleanExtension}`,
      extension: cleanExtension,
      turnServer: turnServer.trim() || DEFAULT_MANUAL_CONFIG.turnServer,
      turnCredentials: {
        username: turnUsername.trim(),
        credential: turnCredential,
      },
      srtp: 'opportunistic',
      registerInterval: 300,
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="manual-setup-title">
      <div className="w-full max-w-[420px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
          <h2 id="manual-setup-title" className="text-lg font-semibold text-gray-900">{editing ? 'Edit registration' : 'Manual setup'}</h2>
          <button type="button" onClick={onClose} className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200" aria-label="Close manual setup">x</button>
        </div>
        <form onSubmit={handleSubmit} className="grid gap-3 px-5 pb-5">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">Extension / SIP username</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="101" autoFocus />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">SIP password</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">Extension</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={extension} onChange={(event) => setExtension(event.target.value)} placeholder="Leave blank to use username" />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">Display name</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Ext 101" />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">Tenant / SIP domain</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={sipDomain} onChange={(event) => setSipDomain(event.target.value)} placeholder="tc-systems-llc.skyetel.money" />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">SIP server / registrar host</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={sipServer} onChange={(event) => setSipServer(event.target.value)} />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">WebSocket URL</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={wssUrl} onChange={(event) => setWssUrl(event.target.value)} />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">TURN server</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={turnServer} onChange={(event) => setTurnServer(event.target.value)} />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">TURN username</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={turnUsername} onChange={(event) => setTurnUsername(event.target.value)} placeholder="Optional" />
          </label>
          <label className="grid gap-1 text-left">
            <span className="text-xs font-semibold text-gray-600">TURN password</span>
            <input className="min-h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100" value={turnCredential} onChange={(event) => setTurnCredential(event.target.value)} type="password" placeholder="Optional" />
            <span className="text-xs leading-5 text-gray-500">QR provisioning generates TURN credentials automatically. Manual setup can register without them, but restrictive networks may need TURN values.</span>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" className="min-h-10 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700">{editing ? 'Save and reconnect' : 'Save and connect'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  const store = useStore();
  installEmbeddedFetchContext();
  const embeddedMode = isEmbeddedWebPhone();
  const sipClientRef = useRef<SoftphoneClient | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const callDurationRef = useRef(0);
  const [incomingCall, setIncomingCall] = useState<IncomingCallLike | null>(null);
  const [secondIncomingCall, setSecondIncomingCall] = useState<IncomingCallLike | null>(null);
  const [secondCallSessionId, setSecondCallSessionId] = useState<string | null>(null);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [showManualSetup, setShowManualSetup] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [answeringSessionId, setAnsweringSessionId] = useState<string | null>(null);
  const pendingAnswerRef = useRef<{ client: SoftphoneClient; sessionId: string } | null>(null);
  const [conferencePending, setConferencePending] = useState(false);
  const conferencePendingRef = useRef(false);
  const [audioSettingsLoaded, setAudioSettingsLoaded] = useState(false);
  const [embeddedBootstrapState, setEmbeddedBootstrapState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'signedOut'>(embeddedMode ? 'loading' : 'idle');
  const [embeddedBootstrapAttempt, setEmbeddedBootstrapAttempt] = useState(0);
  const [supervisorCapabilities, setSupervisorCapabilities] = useState<SupervisorCapabilities | null>(null);
  const [inputModal, setInputModal] = useState<{
    title: string;
    placeholder?: string;
    onSubmit: (value: string) => void;
  } | null>(null);
  const outboundRingbackAudioRef = useRef<{
    context: AudioContext;
    gain: GainNode;
    audio: HTMLAudioElement;
    destination: MediaStreamAudioDestinationNode;
    oscillators: OscillatorNode[];
    cadenceTimer: ReturnType<typeof setInterval>;
  } | null>(null);
  const incomingAlertRef = useRef<IncomingCallAlertCoordinator | null>(null);
  if (!incomingAlertRef.current) incomingAlertRef.current = new IncomingCallAlertCoordinator();
  const secondCallSessionIdRef = useRef<string | null>(null);
  const localRingtoneOwnedRef = useRef(false);
  const callLifecycleRef = useRef(new CallWaitingLifecycle());
  const secondIncomingCallRef = useRef<IncomingCallLike | null>(null);
  const holdPendingRef = useRef(false);

  const isInCall = usesActiveCallControls(store.call.status);
  const isCallActive = store.call.status === 'active';

  // Announcer for screen reader
  const announce = useAnnouncer();

  const requestMicrophoneForCall = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const inputDeviceId = useStore.getState().audioInputDevice;
    const audio = inputDeviceId && inputDeviceId !== 'default'
      ? { deviceId: { exact: inputDeviceId } }
      : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    stream.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    Storage.get(CALL_HISTORY_STORAGE_KEY).then((saved) => {
      const entries = normalizeStoredCallHistory(saved);
      if (entries.length > 0) {
        store.setCallHistory(entries);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!store.sipConfig?.extension) return;
    const embedded = !!store.sipConfig.embedded;
    const domain = store.sipConfig.sipDomain || store.sipConfig.sipServer;
    const domainQuery = domain ? `?domain=${encodeURIComponent(domain)}` : '';
    const historyPath = embedded
      ? `/api/softphone/recents?extension=${encodeURIComponent(store.sipConfig.extension)}&tenant=${encodeURIComponent(domain)}`
      : `/api/connect/history/${store.sipConfig.extension}${domainQuery}`;
    fetch(apiUrlForConfig(historyPath, store.sipConfig))
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!Array.isArray(data)) return;
        const apiEntries: CallHistoryEntry[] = data.map((entry, index) => {
          const timestamp = entry.time || entry.start_ts;
          const caller = entry.caller || entry.src;
          const destination = entry.destination || entry.dst;
          return {
            id: `api-${timestamp || index}`,
            direction: entry.direction === 'inbound' ? 'inbound' as const : 'outbound' as const,
            remoteNumber: entry.direction === 'inbound' ? String(caller || '') : String(destination || ''),
            remoteName: String(entry.caller_name || ''),
            timestamp: timestamp ? new Date(timestamp) : new Date(),
            duration: Number.isFinite(Number(entry.duration ?? entry.duration_s)) ? Number(entry.duration ?? entry.duration_s) : 0,
          };
        }).filter((entry) => entry.remoteNumber);
        if (apiEntries.length > 0) {
          store.setCallHistory(mergeCallHistory(apiEntries, useStore.getState().callHistory));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sipConfig]);

  useEffect(() => {
    Storage.set(CALL_HISTORY_STORAGE_KEY, JSON.stringify(store.callHistory));
  }, [store.callHistory]);

  useEffect(() => {
    let cancelled = false;
    Storage.get(AUDIO_SETTINGS_STORAGE_KEY)
      .then((saved) => {
        if (cancelled) return;
        const settings = normalizeStoredAudioSettings(saved);
        if (settings.inputDeviceId) store.setAudioInputDevice(settings.inputDeviceId);
        if (settings.outputDeviceId) store.setAudioOutputDevice(settings.outputDeviceId);
        if (settings.ringtone) store.setRingtone(settings.ringtone);
        if (typeof settings.volume === 'number') store.setVolume(settings.volume);
      })
      .finally(() => {
        if (!cancelled) setAudioSettingsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!audioSettingsLoaded) return;
    void Storage.set(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify({
      inputDeviceId: store.audioInputDevice,
      outputDeviceId: store.audioOutputDevice,
      ringtone: store.ringtone,
      volume: store.volume,
    }));
  }, [audioSettingsLoaded, store.audioInputDevice, store.audioOutputDevice, store.ringtone, store.volume]);

  const stopOutboundRingback = useCallback(() => {
    const ringback = outboundRingbackAudioRef.current;
    outboundRingbackAudioRef.current = null;
    if (!ringback) return;

    clearInterval(ringback.cadenceTimer);
    ringback.gain.gain.cancelScheduledValues(ringback.context.currentTime);
    ringback.gain.gain.setValueAtTime(0, ringback.context.currentTime);
    ringback.oscillators.forEach((oscillator) => {
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
      oscillator.disconnect();
    });
    ringback.gain.disconnect();
    ringback.destination.disconnect();
    ringback.audio.pause();
    ringback.audio.srcObject = null;
    void ringback.context.close().catch(() => {});
  }, []);

  const stopIncomingRingtone = useCallback(() => {
    incomingAlertRef.current?.stop();
  }, []);

  const startIncomingRingtone = useCallback(() => {
    const state = useStore.getState();
    incomingAlertRef.current?.setDnd(state.dndEnabled);
    if (!localRingtoneOwnedRef.current) return !state.dndEnabled;
    return incomingAlertRef.current?.incoming({
      name: state.ringtone,
      outputDeviceId: state.audioOutputDevice,
      volume: state.volume,
    }) ?? false;
  }, []);

  const playCallWaitingTone = useCallback(() => {
    const state = useStore.getState();
    incomingAlertRef.current?.setDnd(state.dndEnabled);
    if (!localRingtoneOwnedRef.current) return !state.dndEnabled;
    return incomingAlertRef.current?.callWaiting({
      name: state.ringtone,
      outputDeviceId: state.audioOutputDevice,
      volume: state.volume,
    }) ?? false;
  }, []);
  const endCallWaitingTone = useCallback(() => {
    incomingAlertRef.current?.endCallWaiting();
  }, []);
  const answerIncomingCall = useCallback(() => {
    const client = sipClientRef.current;
    if (!client) return;
    const sessionId = client.getActiveSessionId();
    if (!sessionId) return;
    if (pendingAnswerRef.current?.client === client && pendingAnswerRef.current.sessionId === sessionId) return;
    const attempt = { client, sessionId };
    pendingAnswerRef.current = attempt;
    setAnsweringSessionId(sessionId);
    setCallError(null);
    stopIncomingRingtone();
    void client.answer(sessionId).catch((error) => {
      if (sipClientRef.current !== client || pendingAnswerRef.current !== attempt) return;
      const activeSessionId = client.getActiveSessionId();
      if (activeSessionId && activeSessionId !== sessionId) return;
      setCallError(error instanceof Error ? error.message : 'Unable to answer incoming call.');
      const current = useStore.getState();
      if (current.call.status === 'ringing' && activeSessionId === sessionId) {
        startIncomingRingtone();
      }
    }).finally(() => {
      if (pendingAnswerRef.current !== attempt) return;
      pendingAnswerRef.current = null;
      setAnsweringSessionId(null);
    });
  }, [startIncomingRingtone, stopIncomingRingtone]);

  const startOutboundRingback = useCallback(() => {
    stopOutboundRingback();

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor() as AudioContext;
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    const audio = new Audio();
    audio.autoplay = true;
    audio.volume = 1;
    audio.srcObject = destination.stream;

    const audioWithSink = audio as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    const sinkId = store.audioOutputDevice && store.audioOutputDevice !== 'default'
      ? store.audioOutputDevice
      : '';
    if (sinkId && audioWithSink.setSinkId) {
      void audioWithSink.setSinkId(sinkId).catch(() => {});
    }

    gain.gain.value = Math.max(0.25, Math.min(store.volume, 100) / 100) * 0.16;
    gain.connect(destination);

    const oscillators = [440, 480].map((frequency) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      return oscillator;
    });

    const audibleGain = gain.gain.value;
    const startedAt = context.currentTime;
    const applyCadence = () => {
      const elapsedMs = (context.currentTime - startedAt) * 1000;
      const inRingWindow = elapsedMs % 6000 < 2000;
      gain.gain.setTargetAtTime(inRingWindow ? audibleGain : 0, context.currentTime, 0.02);
    };
    const cadenceTimer = setInterval(applyCadence, 100);
    applyCadence();

    void context.resume().catch(() => {});
    void audio.play().catch(() => {
      try {
        gain.connect(context.destination);
      } catch {
        // The media element path is preferred, but direct output is a useful fallback.
      }
    });
    outboundRingbackAudioRef.current = { context, gain, audio, destination, oscillators, cadenceTimer };
  }, [stopOutboundRingback, store.audioOutputDevice, store.volume]);

  const startOutboundCall = useCallback(async (rawNumber: string) => {
    const number = rawNumber.trim();
    if (!number) return;

    const state = useStore.getState();
    const client = sipClientRef.current;
    setCallError(null);

    if (!client || !state.registered) {
      const message = 'Phone is not registered yet.';
      setCallError(message);
      announce(message);
      return;
    }

    state.setCall({ status: 'dialing', direction: 'outbound', remoteNumber: number });
    state.setDialInput('');
    startOutboundRingback();

    try {
      await requestMicrophoneForCall();
      const sessionId = await client.call(number);
      callLifecycleRef.current.setPrimary({
        sessionId,
        remoteNumber: number,
        remoteName: '',
        direction: 'outbound',
        duration: 0,
      });
    } catch (error) {
      stopOutboundRingback();
      const message = error instanceof Error ? error.message : 'Call failed before it reached the SIP server.';
      console.error('Outbound call failed:', error);
      useStore.getState().resetCall();
      callLifecycleRef.current.clear();
      setCallError(message);
      announce(`Call failed. ${message}`);
    }
  }, [announce, requestMicrophoneForCall, startOutboundRingback, stopOutboundRingback]);

  // Background audio keep-alive during calls
  useBackgroundAudio(
    isInCall,
    platformUsesNativeEngine(Capacitor.getPlatform(), store.sipConfig?.mobile?.engine)
  );

  // Native app lifecycle (back button, app state)
  useAppLifecycle();

  // Call quality metrics
  const { metrics: callQualityMetrics, qualityAggregateRef } = useCallQuality(
    sipClientRef.current?.getPeerConnection() ?? null,
    isCallActive,
    sipClientRef.current?.getActiveSessionId() ?? undefined
  );

  // Screen pop for inbound calls
  const screenPop = useScreenPop({
    callerNumber: store.call.remoteNumber,
    extension: store.sipConfig?.extension || '',
    isInboundActive: isCallActive && store.call.direction === 'inbound',
    enabled: store.screenPopEnabled,
    webhookUrl: store.crmWebhookUrl,
    sipConfig: store.sipConfig,
  });

  // Auto-update
  const autoUpdate = useAutoUpdate();
  useNativeMobileRegistration(store.sipConfig);

  const toggleHold = useCallback(async () => {
    if (holdPendingRef.current || conferencePendingRef.current) return;
    const client = sipClientRef.current;
    if (!client) {
      setCallError('The active call is no longer available.');
      return;
    }
    const sessionId = client.getActiveSessionId();
    if (!sessionId) return;

    const wasHeld = useStore.getState().call.held;
    holdPendingRef.current = true;
    setCallError(null);
    try {
      if (wasHeld) {
        await client.unhold();
      } else {
        await client.hold();
      }
      if (sipClientRef.current !== client || client.getActiveSessionId() !== sessionId) return;
      store.setCall({
        held: !wasHeld,
        status: wasHeld ? 'active' : 'held',
      });
    } catch (error) {
      if (sipClientRef.current === client) {
        setCallError(error instanceof Error ? error.message : 'Unable to change hold state.');
      }
    } finally {
      holdPendingRef.current = false;
    }
  }, [store]);

  // Keyboard navigation
  useKeyboardNav({
    onDial: useCallback(() => {
      void startOutboundCall(store.dialInput);
    }, [store.dialInput, startOutboundCall]),
    onAnswer: answerIncomingCall,
    onHangup: useCallback(() => {
      stopOutboundRingback();
      sipClientRef.current?.hangup();
    }, [stopOutboundRingback]),
    onDTMF: useCallback((digit: string) => {
      sipClientRef.current?.sendDTMF(digit);
    }, []),
    onMuteToggle: useCallback(() => {
      const muted = sipClientRef.current?.toggleMute() ?? false;
      store.setCall({ muted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    onHoldToggle: useCallback(() => {
      void toggleHold();
    }, [toggleHold]),
    isInCall,
    hasIncoming: !!incomingCall && !isInCall,
  });

  // Deep link handling for native
  useEffect(() => {
    if (!isNative()) return;

    const handleUrl = (event: { url: string }) => {
      handleDeepLink(
        event.url,
        (config) => store.setSipConfig(config),
        (message) => setCallError(`Provisioning failed: ${message}`),
      );
    };

    // Check if app was opened via deep link
    import('@capacitor/app').then(({ App: CapApp }) => {
      CapApp.getLaunchUrl().then((result) => {
        if (result?.url) handleUrl({ url: result.url });
      });
      CapApp.addListener('appUrlOpen', handleUrl);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Electron deep link handling
  useEffect(() => {
    if (!isElectron()) return;
    const api = window.electronAPI;
    api?.onDeepLink?.((url: string) => {
      handleDeepLink(
        url,
        (config) => store.setSipConfig(config),
        (message) => setCallError(`Provisioning failed: ${message}`),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle ?dial=NUMBER URL parameter (for Chrome extension)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const dialNumber = params.get('dial');
    if (dialNumber && store.registered) {
      void startOutboundCall(dialNumber);
      window.history.replaceState({}, '', '/');
    }
  }, [store.registered, startOutboundCall]);

  // Initialize SIP client when config is available
  useEffect(() => {
    if (!store.sipConfig) return;
    incomingAlertRef.current?.markDndUnknown();
    const callLifecycle = callLifecycleRef.current;

    const useNativeEngine = platformUsesNativeEngine(Capacitor.getPlatform(), store.sipConfig.mobile?.engine);
    localRingtoneOwnedRef.current = platformUsesLocalRingtone(Capacitor.getPlatform(), store.sipConfig.mobile?.engine);
    const client: SoftphoneClient = useNativeEngine
      ? new NativeSipClient(store.sipConfig)
      : new SipClient(store.sipConfig, {
        inputDeviceId: store.audioInputDevice,
        outputDeviceId: store.audioOutputDevice,
        volume: store.volume,
      });
    const findSessionId = (session: IncomingCallLike) => (
      client as unknown as { findSessionId: (value: IncomingCallLike) => string | null }
    ).findSessionId(session);
    const notifyHost = (status: string, event?: string) => {
      if (store.sipConfig?.embedded && window.parent !== window) {
        window.parent.postMessage({ type: 'skyevox-connect', status, event }, window.location.origin);
      }
    };
    const startCallTimer = (initialDuration: number) => {
      clearInterval(timerRef.current ?? undefined);
      callDurationRef.current = initialDuration;
      setCallDuration(initialDuration);
      timerRef.current = setInterval(() => {
        callDurationRef.current += 1;
        setCallDuration(callDurationRef.current);
      }, 1000);
    };
    const recordCallHistory = (
      call: { direction: 'inbound' | 'outbound'; remoteNumber: string; remoteName: string },
      duration: number,
    ) => {
      store.addCallHistory({
        id: Date.now().toString(),
        direction: call.direction,
        remoteNumber: call.remoteNumber,
        remoteName: call.remoteName,
        timestamp: new Date(),
        duration,
        qualityMetrics: qualityAverages(qualityAggregateRef.current),
      });
    };

    client.onRegistered = () => {
      store.setRegistered(true);
      setCallError(null);
      notifyHost('Online');
      void claimPendingBrowserCalls(store.sipConfig!).catch(() => {});
    };
    client.onUnregistered = () => {
      stopIncomingRingtone();
      const current = useStore.getState();
      if (current.call.status === 'ringing') {
        void client.hangup().catch((error) => {
          setCallError(error instanceof Error ? error.message : 'Unable to end ringing call while offline.');
        });
      }
      const waitingSession = secondCallSessionIdRef.current;
      if (waitingSession) {
        void client.rejectSecondCall(waitingSession).catch((error) => {
          setCallError(error instanceof Error ? error.message : 'Unable to reject waiting call while offline.');
        });
      }
      current.setRegistered(false);
      notifyHost('Offline');
    };

    client.onIncomingCall = (invitation: IncomingCallLike) => {
      const sessionId = findSessionId(invitation);
      if (!sessionId || !startIncomingRingtone()) {
        if (sessionId) {
          void client.hangup(sessionId).catch(() => {});
        } else {
          void invitation.reject().catch(() => {});
        }
        return;
      }

      const remoteId = invitation.remoteIdentity;
      const callerName = remoteId.displayName || '';
      const callerNumber = remoteId.uri.user || '';
      callLifecycle.setPrimary({
        sessionId,
        remoteNumber: callerNumber,
        remoteName: callerName,
        direction: 'inbound',
        duration: 0,
      });
      callDurationRef.current = 0;
      setCallError(null);
      setAnsweringSessionId(null);

      store.setCall({
        status: 'ringing',
        direction: 'inbound',
        remoteNumber: callerNumber,
        remoteName: callerName,
      });
      setIncomingCall(invitation);
      notifyHost('Incoming call', 'incoming');
      announce(t('call.incomingFrom', { name: callerName || callerNumber }));

      // Electron native notification
      if (isElectron()) {
        void window.electronAPI?.notifyIncomingCall(callerName, callerNumber).catch((error) => {
          console.warn('Incoming call desktop notification failed:', error);
        });
      }
    };

    client.onSecondIncomingCall = (invitation: IncomingCallLike) => {
      const sessionId = findSessionId(invitation);
      if (!sessionId || !playCallWaitingTone()) {
        if (sessionId) void client.rejectSecondCall(sessionId).catch(() => {});
        else void invitation.reject().catch(() => {});
        return;
      }

      const remoteId = invitation.remoteIdentity;
      callLifecycle.updatePrimaryDuration(callDurationRef.current);
      callLifecycle.setWaiting({
        sessionId,
        remoteNumber: remoteId.uri.user || '',
        remoteName: remoteId.displayName || '',
        direction: 'inbound',
        duration: 0,
      });
      store.setSecondCall({
        status: 'ringing',
        direction: 'inbound',
        remoteNumber: remoteId.uri.user || '',
        remoteName: remoteId.displayName || '',
      });
      setSecondIncomingCall(invitation);
      secondIncomingCallRef.current = invitation;
      setSecondCallSessionId(sessionId);
      secondCallSessionIdRef.current = sessionId;
      notifyHost('Call waiting', 'incoming');
    };

    client.onCallEstablished = (sessionId: string) => {
      setCallError(null);
      stopIncomingRingtone();
      stopOutboundRingback();
      callLifecycle.updatePrimaryDuration(callDurationRef.current);
      const transition = callLifecycle.established(sessionId);
      if (transition.kind === 'second') {
        secondCallSessionIdRef.current = null;
        secondIncomingCallRef.current = null;
        store.setCall({
          status: 'active',
          direction: transition.call.direction,
          remoteNumber: transition.call.remoteNumber,
          remoteName: transition.call.remoteName,
          held: false,
        });
        store.setSecondCall(null);
        setSecondIncomingCall(null);
        setSecondCallSessionId(null);
      } else if (transition.kind === 'unknown') {
        const current = useStore.getState().call;
        callLifecycle.setPrimary({
          sessionId,
          remoteNumber: current.remoteNumber,
          remoteName: current.remoteName,
          direction: current.direction || 'outbound',
          duration: 0,
        });
        store.setCall({ status: 'active' });
      } else {
        store.setCall({ status: 'active' });
      }
      setIncomingCall(null);
      startCallTimer(0);
      announce(t('call.connected'));
    };

    client.onCallEnded = (sessionId: string) => {
      stopOutboundRingback();
      if (secondCallSessionIdRef.current && sessionId !== secondCallSessionIdRef.current) {
        callLifecycle.updatePrimaryDuration(callDurationRef.current);
      }
      const transition = callLifecycle.ended(sessionId);
      if (transition.kind === 'unknown') return;

      if (transition.kind === 'waiting-ended') {
        secondCallSessionIdRef.current = null;
        secondIncomingCallRef.current = null;
        endCallWaitingTone();
        store.setSecondCall(null);
        setSecondIncomingCall(null);
        setSecondCallSessionId(null);
        return;
      }

      if (transition.kind === 'promote-waiting') {
        clearInterval(timerRef.current ?? undefined);
        timerRef.current = null;
        const promotedInvitation = secondIncomingCallRef.current;
        secondCallSessionIdRef.current = null;
        secondIncomingCallRef.current = null;
        store.setSecondCall(null);
        setSecondIncomingCall(null);
        setSecondCallSessionId(null);
        recordCallHistory(transition.ended, transition.ended.duration);
        callDurationRef.current = 0;
        setCallDuration(0);
        store.setCall({
          status: 'ringing',
          direction: transition.promoted.direction,
          remoteNumber: transition.promoted.remoteNumber,
          remoteName: transition.promoted.remoteName,
          held: false,
        });
        setIncomingCall(promotedInvitation);
        if (!startIncomingRingtone()) {
          void client.hangup(transition.promoted.sessionId).catch((error) => {
            setCallError(error instanceof Error ? error.message : 'Unable to end promoted call for DND.');
          });
          return;
        }
        announce(t('call.incomingFrom', {
          name: transition.promoted.remoteName || transition.promoted.remoteNumber,
        }));
        return;
      }

      if (transition.kind === 'primary-ended-under-second') {
        store.setConferenceActive(false);
        recordCallHistory(transition.ended, transition.ended.duration);
        announce(t('call.ended'));
        return;
      }

      if (transition.kind === 'restore-primary') {
        stopIncomingRingtone();
        clearInterval(timerRef.current ?? undefined);
        recordCallHistory(transition.ended, callDurationRef.current);
        secondCallSessionIdRef.current = null;
        store.setSecondCall(null);
        void client.unhold(transition.primary.sessionId).catch(() => {});
        store.setCall({
          status: 'active',
          direction: transition.primary.direction,
          remoteNumber: transition.primary.remoteNumber,
          remoteName: transition.primary.remoteName,
          held: false,
        });
        store.setConferenceActive(false);
        startCallTimer(transition.primary.duration);
        announce(t('call.ended'));
        return;
      }

      stopIncomingRingtone();
      clearInterval(timerRef.current ?? undefined);
      recordCallHistory(transition.ended, callDurationRef.current);
      announce(t('call.ended'));
      store.resetCall();
      store.setConferenceActive(false);
      store.setSecondCall(null);
      callDurationRef.current = 0;
      setCallDuration(0);
      setIncomingCall(null);
      setSecondIncomingCall(null);
      setSecondCallSessionId(null);
      secondCallSessionIdRef.current = null;
      secondIncomingCallRef.current = null;
    };

    client.onConferenceMerged = () => {
      stopIncomingRingtone();
      store.setConferenceActive(true);
      store.setSecondCall(null);
      setSecondIncomingCall(null);
      setSecondCallSessionId(null);
      secondCallSessionIdRef.current = null;
      secondIncomingCallRef.current = null;
    };

    client.connect().catch((err) => {
      console.error('SIP connect failed:', err);
      setCallError(err instanceof Error ? err.message : 'SIP connect failed.');
    });
    sipClientRef.current = client;

    return () => {
      stopOutboundRingback();
      localRingtoneOwnedRef.current = false;
      stopIncomingRingtone();
      callLifecycle.clear();
      secondIncomingCallRef.current = null;
      secondCallSessionIdRef.current = null;
      clearInterval(timerRef.current ?? undefined);
      void client.disconnect().catch((error) => {
        console.warn('SIP disconnect cleanup failed:', error);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sipConfig]);
  useEffect(() => {
    if (!store.sipConfig?.embedded) return;
    return startBrowserPushHeartbeat(store.sipConfig);
  }, [store.sipConfig]);

  useEffect(() => {
    const config = store.sipConfig;
    if (!config) return;
    const recover = () => {
      const client = sipClientRef.current;
      if (client && 'recoverRegistration' in client) {
        client.recoverRegistration()
          .then(() => {
            void claimPendingBrowserCalls(config).catch(() => {});
            if (window.parent !== window) {
              window.parent.postMessage({ type: 'skyevox-connect', status: 'Online', event: 'recovered' }, window.location.origin);
            }
          })
          .catch(() => {
            if (window.parent !== window) {
              window.parent.postMessage({ type: 'skyevox-connect', status: 'Offline', event: 'recovery-failed' }, window.location.origin);
            }
          });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recover();
    };
    const onPushOpen = (event: MessageEvent) => {
      if (event.origin && event.origin !== window.location.origin) return;
      if (event.data?.type === 'skyevox-push-open') recover();
    };
    window.addEventListener('message', onPushOpen);
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    window.addEventListener('pageshow', recover);
    document.addEventListener('visibilitychange', onVisibility);
    navigator.serviceWorker?.addEventListener('message', onPushOpen);
    return () => {
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
      window.removeEventListener('pageshow', recover);
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker?.removeEventListener('message', onPushOpen);
      window.removeEventListener('message', onPushOpen);
    };
  }, [store.sipConfig]);

  useEffect(() => {
    const client = sipClientRef.current as (SoftphoneClient & {
      updateAudioDevices?: (settings: AudioDeviceSettings) => void;
    }) | null;
    client?.updateAudioDevices?.({
      inputDeviceId: store.audioInputDevice,
      outputDeviceId: store.audioOutputDevice,
      volume: store.volume,
    });
  }, [store.audioInputDevice, store.audioOutputDevice, store.volume]);

  // Load session-scoped embedded credentials, provisioning token, or local configuration.
  useEffect(() => {
    if (embeddedMode) {
      setEmbeddedBootstrapState('loading');
      setCallError(null);
      loadEmbeddedSipConfig()
        .then((config) => {
          store.setSipConfig(config);
          setEmbeddedBootstrapState('ready');
        })
        .catch((error) => {
          setEmbeddedBootstrapState('error');
          setCallError(error instanceof Error ? error.message : 'Web phone session sign-in failed.');
        });
    } else {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) {
        fetch(apiUrl(`/api/provisioning/${token}`))
          .then((r) => r.json())
          .then((config) => {
            const sipConfig = sipConfigFromProvisioning(config);
            store.setSipConfig(sipConfig);
            Storage.set('skyevox_config', JSON.stringify(sipConfig));
            window.history.replaceState({}, '', '/');
          })
          .catch((err) => console.error('Provisioning failed:', err));
      } else {
        Storage.get('skyevox_config').then((saved) => {
          if (saved) {
            const sipConfig = normalizeSipConfig(JSON.parse(saved));
            store.setSipConfig(sipConfig);
            Storage.set('skyevox_config', JSON.stringify(sipConfig));
          }
        });
      }
    }

    Storage.get('skyevox_screen_pop_enabled').then((v) => {
      if (v === 'true') store.setScreenPopEnabled(true);
    });
    Storage.get('skyevox_crm_webhook_url').then((v) => {
      if (v) store.setCrmWebhookUrl(v);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddedBootstrapAttempt, embeddedMode]);

  useEffect(() => {
    const config = store.sipConfig;
    let cancelled = false;
    let inFlight = false;
    setSupervisorCapabilities(null);
    if (!config?.extension) return;
    const revoke = () => {
      setSupervisorCapabilities(null);
      if (useStore.getState().activeTab === 'supervisor') store.setActiveTab('dialpad');
    };
    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const capabilities = await fetchSupervisorCapabilities(config);
        if (cancelled) return;
        if (capabilities.enabled) setSupervisorCapabilities(capabilities);
        else revoke();
      } catch {
        if (!cancelled) revoke();
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const interval = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [store.sipConfig]);

  // Fetch extension directory
  useEffect(() => {
    const config = store.sipConfig;
    if (!config) return;
    const controller = new AbortController();
    void fetchDirectory(config, controller.signal)
      .then((entries) => {
        if (useStore.getState().sipConfig !== config || controller.signal.aborted) return;
        store.setExtensions(directoryExtensions(entries));
        store.setDirectoryLoaded(true);
      })
      .catch(() => {
        if (useStore.getState().sipConfig === config && !controller.signal.aborted) store.setDirectoryLoaded(true);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sipConfig]);

  // Hydrate local DND state. The PBX remains authoritative when this API is unavailable.
  useEffect(() => {
    const config = store.sipConfig;
    if (!config?.extension) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    incomingAlertRef.current?.markDndUnknown();
    const load = () => {
      fetchDndState(config)
        .then((enabled) => {
          if (cancelled || useStore.getState().sipConfig !== config) return;
          incomingAlertRef.current?.setDnd(enabled);
          store.setDndEnabled(enabled);
        })
        .catch((error) => {
          if (cancelled) return;
          console.warn('DND state unavailable; using server-authoritative inbound routing:', error);
          retryTimer = window.setTimeout(load, 5_000);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      incomingAlertRef.current?.markDndUnknown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sipConfig]);

  useEffect(() => {
    const config = store.sipConfig;
    if (!config?.extension) return;
    incomingAlertRef.current?.setDnd(store.dndEnabled);
    if (!store.dndEnabled) return;

    const client = sipClientRef.current;
    if (!client) return;
    const current = useStore.getState();
    if (current.call.status === 'ringing') {
      void client.hangup().catch((error) => {
        setCallError(error instanceof Error ? error.message : 'Unable to reject incoming call for DND.');
      });
    }
    const waitingSession = secondCallSessionIdRef.current;
    if (waitingSession) {
      void client.rejectSecondCall(waitingSession).catch((error) => {
        setCallError(error instanceof Error ? error.message : 'Unable to reject waiting call for DND.');
      });
    }
  }, [store.dndEnabled, store.sipConfig]);

  // Fetch voicemail count on config load and periodically
  useEffect(() => {
    if (!store.sipConfig?.extension) return;
    const config = store.sipConfig;
    const fetchCount = () => {
      fetch(voicemailApiUrl(`/api/connect/voicemail/${config.extension}/count`), {
        headers: voicemailApiHeaders(config),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`Voicemail count request failed: ${r.status}`);
          return r.json();
        })
        .then((data) => {
          const unread = typeof data.unread === 'number'
            ? data.unread
            : typeof data.count === 'number' ? data.count : null;
          if (unread !== null) {
            store.setUnreadVoicemailCount(useStore.getState().activeTab === 'voicemail' ? 0 : unread);
          }
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sipConfig]);

  const handleDial = useCallback((number: string) => {
    void startOutboundCall(number);
  }, [startOutboundCall]);

  const handleManualSetupSave = useCallback((sipConfig: SipConfig) => {
    store.setRegistered(false);
    store.setSipConfig(sipConfig);
    Storage.set('skyevox_config', JSON.stringify(sipConfig));
    setShowManualSetup(false);
  }, [store]);

  const handlePhoneSignOut = useCallback(async () => {
    const config = useStore.getState().sipConfig;
    if (!config?.embedded) return;
    await Promise.race([
      disableBrowserPush(config).catch(() => {}),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
    ]);
    const client = sipClientRef.current;
    sipClientRef.current = null;
    await Promise.resolve(client?.disconnect()).catch(() => {});
    stopOutboundRingback();
    stopIncomingRingtone();
    callLifecycleRef.current.clear();
    secondCallSessionIdRef.current = null;
    secondIncomingCallRef.current = null;
    store.setRegistered(false);
    store.setSipConfig(null);
    setCallError(null);
    setEmbeddedBootstrapState('signedOut');
    window.opener?.postMessage({ type: 'skyevox-connect', status: 'Signed out', event: 'signed-out' }, window.location.origin);
    window.close();
  }, [stopIncomingRingtone, stopOutboundRingback, store]);

  // Sign out (native/standalone): release the account but keep app preferences.
  // Unregistering the device server-side stops push wake for this phone.
  const handleSignOut = useCallback(async () => {
    const config = useStore.getState().sipConfig;
    if (!config || config.embedded) return;
    const deviceId = await Storage.get('skyevox_connect_device_id').catch(() => null);
    if (deviceId && isNative()) {
      await Promise.race([
        unregisterMobileDevice(config, {
          deviceId,
          platform: Capacitor.getPlatform() as 'ios' | 'android',
          capabilities: {
            engine: config.mobile?.engine === 'liblinphone' ? 'liblinphone' : 'sipjs',
            defaultCallingEligible: false,
            sms: false,
            mms: false,
          },
        }).catch(() => {}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
      ]);
    }
    const client = sipClientRef.current;
    sipClientRef.current = null;
    await Promise.resolve(client?.disconnect()).catch(() => {});
    stopOutboundRingback();
    stopIncomingRingtone();
    callLifecycleRef.current.clear();
    secondCallSessionIdRef.current = null;
    secondIncomingCallRef.current = null;
    await Storage.remove('skyevox_config');
    store.setRegistered(false);
    store.setSipConfig(null);
    setCallError(null);
  }, [stopIncomingRingtone, stopOutboundRingback, store]);

  // Reset app: sign out, erase every stored preference, and reboot the UI to
  // the fresh-install provisioning screen.
  const handleResetApp = useCallback(async () => {
    await handleSignOut();
    for (const key of [
      'skyevox_config',
      'skyevox_connect_device_id',
      'skyevox_crm_webhook_url',
      'skyevox_language',
      'skyevox_screen_pop_enabled',
    ]) {
      await Storage.remove(key).catch(() => {});
    }
    window.location.reload();
  }, [handleSignOut]);

  const handleAnswer = useCallback(() => {
    answerIncomingCall();
  }, [answerIncomingCall]);

  const handleHangup = useCallback(() => {
    stopIncomingRingtone();
    stopOutboundRingback();
    sipClientRef.current?.hangup();
  }, [stopIncomingRingtone, stopOutboundRingback]);

  const handleMute = useCallback(() => {
    const muted = sipClientRef.current?.toggleMute() ?? false;
    store.setCall({ muted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHold = useCallback(() => {
    void toggleHold();
  }, [toggleHold]);

  // Transfer via InputModal instead of prompt()
  const handleTransfer = useCallback(() => {
    setInputModal({
      title: t('transfer.title'),
      placeholder: t('transfer.placeholder'),
      onSubmit: (target) => {
        const client = sipClientRef.current;
        setInputModal(null);
        setCallError(null);
        if (!client) {
          setCallError('The active call is no longer available.');
          return;
        }
        void client.transfer(target).catch((error: unknown) => {
          setCallError(error instanceof Error ? error.message : 'Unable to transfer the call.');
        });
      },
    });
  }, [t]);

  const handleDTMF = useCallback((digit: string) => {
    sipClientRef.current?.sendDTMF(digit);
  }, []);

  const handlePark = useCallback((destination?: string): Promise<void> => {
    stopOutboundRingback();
    const client = sipClientRef.current;
    const parkTarget = destination?.trim()
      || useStore.getState().sipConfig?.parkCode?.trim();
    if (!client || !parkTarget) {
      return Promise.reject(new Error('Call park is not configured.'));
    }
    return client.transfer(parkTarget);
  }, [stopOutboundRingback]);

  // Conference handler: hold current, dial second party
  const handleConference = useCallback(() => {
    if (conferencePendingRef.current || holdPendingRef.current) return;
    if (store.conferenceActive) {
      const client = sipClientRef.current;
      if (!client) return;
      conferencePendingRef.current = true;
      setConferencePending(true);
      setCallError(null);
      void client.splitConference()
        .catch((error) => {
          setCallError(error instanceof Error ? error.message : 'Unable to split conference audio.');
        })
        .finally(() => {
          if (sipClientRef.current === client) store.setConferenceActive(client.conferenceActive);
          conferencePendingRef.current = false;
          setConferencePending(false);
        });
      return;
    }
    setInputModal({
      title: t('conference.title'),
      placeholder: t('conference.placeholder'),
      onSubmit: (target) => {
        if (conferencePendingRef.current) return;
        const client = sipClientRef.current;
        if (client) {
          conferencePendingRef.current = true;
          setConferencePending(true);
          setCallError(null);
          callLifecycleRef.current.updatePrimaryDuration(callDurationRef.current);
          void client.conferenceCall(target)
            .then((sessionId) => {
              if (!sessionId) throw new Error('No active call is available to conference.');
              callLifecycleRef.current.setWaiting({
                sessionId,
                remoteNumber: target,
                remoteName: '',
                direction: 'outbound',
                duration: 0,
              });
              secondCallSessionIdRef.current = sessionId;
              store.setCall({ held: true, status: 'held' });
              store.setSecondCall({ status: 'dialing', direction: 'outbound', remoteNumber: target, remoteName: '' });
              startOutboundRingback();
            })
            .catch((error) => {
              store.setCall({ held: false, status: 'active' });
              setCallError(error instanceof Error ? error.message : 'Unable to start conference call.');
            })
            .finally(() => {
              conferencePendingRef.current = false;
              setConferencePending(false);
            });
        }
        setInputModal(null);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.conferenceActive, startOutboundRingback, t]);

  // Merge handler
  const handleMerge = useCallback(() => {
    const client = sipClientRef.current;
    if (!client || conferencePendingRef.current) return;
    conferencePendingRef.current = true;
    setConferencePending(true);
    setCallError(null);
    void client.mergeCall()
      .then(() => store.setCall({ held: false, status: 'active' }))
      .catch((error) => {
        store.setConferenceActive(false);
        setCallError(error instanceof Error ? error.message : 'Unable to merge conference audio.');
      })
      .finally(() => {
        conferencePendingRef.current = false;
        setConferencePending(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop participant from conference
  const handleDropParticipant = useCallback((sessionId: string) => {
    void sipClientRef.current?.dropParticipant(sessionId).catch((error) => {
      setCallError(error instanceof Error ? error.message : 'Unable to drop conference participant.');
    });
  }, []);

  // Call waiting handlers
  const handleCallWaitingAnswer = useCallback(() => {
    const client = sipClientRef.current;
    if (!client || !secondCallSessionId) return;
    void client.answerSecondCall(secondCallSessionId).catch((error) => {
      console.warn('Unable to answer waiting call:', error);
      endCallWaitingTone();
    });
  }, [endCallWaitingTone, secondCallSessionId]);

  const handleCallWaitingReject = useCallback(() => {
    const client = sipClientRef.current;
    if (!client || !secondCallSessionId) return;
    void client.rejectSecondCall(secondCallSessionId).catch((error) => {
      console.warn('Unable to reject waiting call:', error);
    });
  }, [secondCallSessionId]);

  const handleCallWaitingMerge = useCallback(() => {
    const client = sipClientRef.current;
    if (!client || !secondCallSessionId || conferencePendingRef.current) return;
    conferencePendingRef.current = true;
    setConferencePending(true);
    setCallError(null);
    void client.answerSecondCall(secondCallSessionId)
      .then(() => client.mergeCall())
      .then(() => store.setCall({ held: false, status: 'active' }))
      .catch((error) => {
        setCallError(error instanceof Error ? error.message : 'Unable to merge waiting call.');
        endCallWaitingTone();
      })
      .finally(() => {
        conferencePendingRef.current = false;
        setConferencePending(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endCallWaitingTone, secondCallSessionId]);

  // QR scan handler — provision from scanned URL
  const handleQRScan = useCallback((data: string) => {
    setShowQRScanner(false);
    // If it's a URL with token, extract and provision. The skyevox:// QR and
    // provisioning links carry the minting API host in their server parameter.
    try {
      const url = new URL(data);
      const token = url.searchParams.get('token');
      if (token) {
        fetch(provisioningUrl(token, url.searchParams.get('server')))
          .then(async (r) => {
            if (!r.ok) {
              const body = await r.json().catch(() => ({} as { error?: string }));
              throw new Error(body.error || `HTTP ${r.status}`);
            }
            return r.json();
          })
          .then((config) => {
            const sipConfig = sipConfigFromProvisioning(config);
            store.setSipConfig(sipConfig);
            Storage.set('skyevox_config', JSON.stringify(sipConfig));
          })
          .catch((err) => {
            console.error('QR provisioning failed:', err);
            setCallError(`Provisioning failed: ${err instanceof Error ? err.message : 'unknown error'}`);
          });
        return;
      }
    } catch {
      // Not a URL
    }
    // If it's a skyevox:// deep link
    if (data.startsWith('skyevox://')) {
      handleDeepLink(
        data,
        (config) => store.setSipConfig(config),
        (message) => setCallError(`Provisioning failed: ${message}`),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const conferenceParticipants = sipClientRef.current?.getEstablishedParticipants() ?? [];
  const canMerge = conferenceParticipants.length === 2 && !store.conferenceActive;

  // On mobile native, use full-screen layout; on web, use centered card
  const isMobile = isNative();

  const tabLabels: Record<string, string> = {
    dialpad: t('tab.dialpad'),
    recent: t('tab.recent'),
    directory: t('tab.directory'),
    voicemail: t('tab.voicemail'),
    messages: t('tab.messages'),
    supervisor: t('tab.supervisor'),
    settings: t('tab.settings'),
  };
  const navigationTabs: Array<'dialpad' | 'recent' | 'directory' | 'voicemail' | 'messages' | 'supervisor' | 'settings'> = [
    'dialpad', 'recent', 'directory', 'voicemail', 'messages', 'settings',
  ];
  if (supervisorCapabilities?.enabled) navigationTabs.splice(5, 0, 'supervisor');

  return (
    <div className={isMobile
      ? 'mobile-fullscreen bg-white flex flex-col no-select'
      : 'min-h-screen connect-portal-background flex items-start justify-center p-6'
    }>
      {/* Skip link for accessibility */}
      <a href="#main-content" className="skip-link">{t('app.skipToContent')}</a>

      <div className={isMobile
        ? 'flex-1 flex flex-col overflow-hidden'
        : 'connect-phone-card bg-white rounded-2xl shadow-xl overflow-hidden border relative'
      }>
        {/* Update Banner */}
        {autoUpdate.updateAvailable && autoUpdate.versionInfo && (
          <UpdateBanner
            versionInfo={autoUpdate.versionInfo}
            mandatory={autoUpdate.mandatory}
            onDismiss={autoUpdate.dismiss}
          />
        )}

        {/* Header */}
        <div className="bg-[#0066B3] text-white px-4 py-3 flex items-center justify-between safe-area-top" role="banner">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
            </svg>
            <span className="font-semibold text-sm">{t('app.title')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* DND badge */}
            {store.dndEnabled && (
              <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full mr-1" role="status">
                {t('app.dnd')}
              </span>
            )}
            <span
              className={`w-2 h-2 rounded-full ${store.registered ? 'bg-green-300' : 'bg-red-300'}`}
              aria-hidden="true"
            />
            <span className="text-xs opacity-80">
              {store.registered ? store.sipConfig?.extension || t('app.ready') : t('app.offline')}
            </span>
          </div>
        </div>

        {/* Main content */}
        <div id="main-content" className={isMobile ? 'flex-1 overflow-y-auto' : 'min-h-[420px]'} role="main">
          {/* Screen Pop overlay */}
          {screenPop.data && isCallActive && store.call.direction === 'inbound' && (
            <ScreenPop data={screenPop.data} onDismiss={screenPop.dismiss} />
          )}

          {callError && (
            <div className="mx-3 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {callError}
            </div>
          )}

          {!store.sipConfig ? (
            embeddedMode ? (
              <div className="flex h-[420px] flex-col items-center justify-center p-6 text-center">
                <div className={`mb-4 h-12 w-12 rounded-full border-4 ${embeddedBootstrapState === 'loading' ? 'animate-spin border-sky-100 border-t-sky-600' : 'border-red-100'}`} aria-hidden="true" />
                <h2 className="mb-1 text-lg font-semibold text-gray-800">
                  {embeddedBootstrapState === 'loading'
                    ? t('welcome.webConnecting')
                    : embeddedBootstrapState === 'signedOut' ? t('welcome.webSignedOut') : t('welcome.webFailed')}
                </h2>
                <p className="mb-4 max-w-xs text-sm text-gray-500">
                  {embeddedBootstrapState === 'signedOut' ? t('welcome.webSignedOutDescription') : t('welcome.webDescription')}
                </p>
                {(embeddedBootstrapState === 'error' || embeddedBootstrapState === 'signedOut') && (
                  <button
                    type="button"
                    onClick={() => setEmbeddedBootstrapAttempt((attempt) => attempt + 1)}
                    className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700"
                  >
                    {embeddedBootstrapState === 'signedOut' ? t('welcome.signBackIn') : t('welcome.retry')}
                  </button>
                )}
              </div>
            ) : (
            <div className="flex flex-col items-center justify-center h-[420px] p-6 text-center">
              <div className="w-16 h-16 rounded-full bg-sky-50 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-sky-600" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-800 mb-1">{t('welcome.title')}</h2>
              <p className="text-sm text-gray-500 mb-4">
                {t('welcome.description')}
              </p>
              {/* QR Scanner button */}
              <button
                onClick={() => setShowQRScanner(true)}
                className="flex items-center gap-2 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 active:scale-95 text-white rounded-lg text-sm font-medium transition-all touch-target"
                aria-label={t('welcome.scanQR')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                </svg>
                {t('welcome.scanQR')}
              </button>
              <button
                onClick={() => setShowManualSetup(true)}
                className="mt-3 px-4 py-2.5 border border-gray-300 hover:bg-gray-50 active:scale-95 text-gray-800 rounded-lg text-sm font-medium transition-all touch-target"
                aria-label="Manual setup"
              >
                Manual setup
              </button>
              <p className="text-xs text-gray-400 mt-4">{t('app.version', { version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '4.0' })}</p>
            </div>
            )
          ) : incomingCall && !isInCall ? (
            <IncomingCall
              callerName={store.call.remoteName}
              callerNumber={store.call.remoteNumber}
              answering={answeringSessionId !== null && sipClientRef.current?.getActiveSessionId() === answeringSessionId}
              onAnswer={handleAnswer}
              onReject={handleHangup}
            />
          ) : isInCall ? (
            <div>
              {store.secondCall?.direction === 'outbound' && store.secondCall.status === 'dialing' && (
                <div className="mx-3 mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700" role="status">
                  {t('conference.dialing', { number: store.secondCall.remoteNumber })}
                </div>
              )}
              <CallControls
                muted={store.call.muted}
                held={store.call.held}
                onMute={handleMute}
                onHold={handleHold}
                onHangup={handleHangup}
                onTransfer={handleTransfer}
                onPark={handlePark}
                onConference={handleConference}
                onMerge={handleMerge}
                duration={formatDuration(callDuration)}
                remoteName={store.call.remoteName}
                remoteNumber={store.call.remoteNumber}
                conferenceActive={store.conferenceActive}
                canMerge={canMerge}
                conferencePending={conferencePending || store.secondCall?.status === 'dialing'}
                conferenceParticipants={conferenceParticipants}
                onDropParticipant={handleDropParticipant}
                qualityMetrics={callQualityMetrics}
              />
              {store.call.status === 'active' && (
                <Dialpad onDial={handleDial} onDTMF={handleDTMF} inCall={true} />
              )}
            </div>
          ) : (
            <>
              {store.activeTab === 'dialpad' && <Dialpad onDial={handleDial} />}
              {store.activeTab === 'recent' && <CallHistory onCall={handleDial} />}
              {store.activeTab === 'directory' && <Directory onCall={handleDial} />}
              {store.activeTab === 'voicemail' && <Voicemail />}
              {store.activeTab === 'messages' && <Messages />}
              {store.activeTab === 'supervisor' && supervisorCapabilities && (
                <Supervisor config={store.sipConfig} capabilities={supervisorCapabilities} />
              )}
              {store.activeTab === 'settings' && (
                <Settings
                  onEditRegistration={embeddedMode ? undefined : () => setShowManualSetup(true)}
                  onPhoneSignOut={embeddedMode ? () => void handlePhoneSignOut() : undefined}
                  onSignOut={embeddedMode ? undefined : () => void handleSignOut()}
                  onResetApp={embeddedMode ? undefined : () => void handleResetApp()}
                />
              )}
            </>
          )}
        </div>

        {/* Call Waiting overlay */}
        {secondIncomingCall && store.secondCall && isInCall && (
          <CallWaiting
            callerName={store.secondCall.remoteName}
            callerNumber={store.secondCall.remoteNumber}
            onAnswerHoldCurrent={handleCallWaitingAnswer}
            onReject={handleCallWaitingReject}
            onMerge={handleCallWaitingMerge}
          />
        )}

        {/* Bottom tabs */}
        {store.sipConfig && !isInCall && (
          <div
            className="grid border-t border-gray-200 safe-area-bottom"
            style={{ gridTemplateColumns: `repeat(${navigationTabs.length}, minmax(0, 1fr))` }}
            role="tablist"
            aria-label={t('tab.dialpad')}
          >
            {navigationTabs.map((tab) => (
              <button
                type="button"
                key={tab}
                role="tab"
                aria-selected={store.activeTab === tab}
                aria-label={tabLabels[tab]}
                onClick={() => {
                  store.setActiveTab(tab);
                  if (tab === 'voicemail') store.setUnreadVoicemailCount(0);
                }}
                className={`min-w-0 overflow-hidden flex flex-col items-center gap-0.5 py-2.5 text-xs transition-colors relative touch-target ${
                  store.activeTab === tab
                    ? 'text-sky-600 bg-sky-50'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {tab === 'dialpad' && (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 19c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM6 1c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12-8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-6 8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
                  </svg>
                )}
                {tab === 'recent' && (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
                  </svg>
                )}
                {tab === 'directory' && (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                )}
                {tab === 'voicemail' && (
                  <div className="relative">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M18.5 6C15.46 6 13 8.46 13 11.5c0 1.33.47 2.55 1.26 3.5H9.74c.79-.95 1.26-2.17 1.26-3.5C11 8.46 8.54 6 5.5 6S0 8.46 0 11.5 2.46 17 5.5 17h13c3.04 0 5.5-2.46 5.5-5.5S21.54 6 18.5 6zm-13 9C3.57 15 2 13.43 2 11.5S3.57 8 5.5 8 9 9.57 9 11.5 7.43 15 5.5 15zm13 0c-1.93 0-3.5-1.57-3.5-3.5S16.57 8 18.5 8 22 9.57 22 11.5 20.43 15 18.5 15z" />
                    </svg>
                    {/* Unread badge */}
                    {store.unreadVoicemailCount > 0 && (
                      <span className="absolute -top-1.5 -right-2 bg-red-500 text-white text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1" aria-label={`${store.unreadVoicemailCount} unread`}>
                        {store.unreadVoicemailCount > 99 ? '99+' : store.unreadVoicemailCount}
                      </span>
                    )}
                  </div>
                )}
                {tab === 'messages' && (
                  <div className="relative">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
                    </svg>
                    {store.unreadMessageCount > 0 && (
                      <span className="absolute -top-1.5 -right-2 bg-sky-600 text-white text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1" aria-label={`${store.unreadMessageCount} unread`}>
                        {store.unreadMessageCount > 99 ? '99+' : store.unreadMessageCount}
                      </span>
                    )}
                  </div>
                )}
                {tab === 'supervisor' && (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2l8 4v6c0 5.05-3.41 9.77-8 11-4.59-1.23-8-5.95-8-11V6l8-4zm0 5a3 3 0 100 6 3 3 0 000-6zm0 8c-2.67 0-5 1.34-5 3v.39A10.46 10.46 0 0012 21a10.46 10.46 0 005-2.61V18c0-1.66-2.33-3-5-3z" />
                  </svg>
                )}
                {tab === 'settings' && (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                )}
                <span className="w-full truncate px-1 text-[10px] sm:text-xs">{tabLabels[tab]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* QR Scanner overlay */}
      {showQRScanner && (
        <QRScanner
          onScan={handleQRScan}
          onClose={() => setShowQRScanner(false)}
        />
      )}

      {showManualSetup && (
        <ManualSetupModal
          onClose={() => setShowManualSetup(false)}
          onSave={handleManualSetupSave}
          initialConfig={store.sipConfig}
        />
      )}

      {/* Input Modal overlay */}
      {inputModal && (
        <InputModal
          title={inputModal.title}
          placeholder={inputModal.placeholder}
          onSubmit={inputModal.onSubmit}
          onCancel={() => setInputModal(null)}
        />
      )}
    </div>
  );
}

export default App;
