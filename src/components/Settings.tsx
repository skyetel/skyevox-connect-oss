import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { isAndroid, isElectron, isIos, isNative } from '../platform';
import { Storage } from '../storage';
import { SkyeVoxNative, type NativeDefaultCallingStatus } from '../native/SkyeVoxNative';
import type { MobileProvisioningConfig, SipConfig } from '../types';
import { browserPushState, disableBrowserPush, enableBrowserPush } from '../api/push';
import { fetchDndState, updateDndState } from '../api/dnd';

declare const __APP_VERSION__: string;

interface SettingsProps {
  onEditRegistration?: () => void;
  onPhoneSignOut?: () => void;
  onSignOut?: () => void;
  onResetApp?: () => void;
}

export function Settings({ onEditRegistration, onPhoneSignOut, onSignOut, onResetApp }: SettingsProps) {
  const { t, i18n } = useTranslation();
  const {
    audioInputDevice, audioOutputDevice, ringtone, volume,
    setAudioInputDevice, setAudioOutputDevice, setRingtone, setVolume,
    registered, sipConfig, setSipConfig, dndEnabled, setDndEnabled,
    screenPopEnabled, setScreenPopEnabled, crmWebhookUrl, setCrmWebhookUrl,
  } = useStore();

  const currentEngine: 'liblinphone' | 'sipjs' =
    sipConfig?.mobile?.engine === 'liblinphone' ? 'liblinphone' : 'sipjs';

  const handleEngineChange = useCallback(async (engine: 'liblinphone' | 'sipjs') => {
    if (!sipConfig || engine === currentEngine) return;
    const base: MobileProvisioningConfig = sipConfig.mobile ?? {
      engine,
      transport: 'tls',
      srtp: 'mandatory',
      pushEnabled: false,
      defaultCallingEligible: false,
      smsEnabled: false,
      mmsEnabled: false,
      e911Enabled: false,
    };
    const next: SipConfig = { ...sipConfig, mobile: { ...base, engine } };
    await Storage.set('skyevox_config', JSON.stringify(next));
    setSipConfig(next);
  }, [sipConfig, currentEngine, setSipConfig]);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [dndSyncing, setDndSyncing] = useState(false);
  const [dndError, setDndError] = useState(false);
  const [desktopSettings, setDesktopSettings] = useState({ autoStart: false, minimizeToTray: true });
  const [defaultCallingStatus, setDefaultCallingStatus] = useState<NativeDefaultCallingStatus | null>(null);
  const [speakerTestState, setSpeakerTestState] = useState<'idle' | 'playing' | 'ok' | 'error'>('idle');
  const [diagnosticLogPath, setDiagnosticLogPath] = useState<string | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushSupported, setPushSupported] = useState(true);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);


  useEffect(() => {
    const refreshDevices = () => {
      navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    };
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
    };
  }, []);
  useEffect(() => {
    if (!sipConfig?.embedded) return;
    browserPushState()
      .then((state) => {
        setPushSupported(state.supported);
        setPushSubscribed(state.subscribed);
      })
      .catch(() => setPushSupported(false));
  }, [sipConfig?.embedded]);

  // Load Electron desktop settings
  useEffect(() => {
    if (!isElectron()) return;
    window.electronAPI?.getSettings?.().then((s) => {
      if (s) setDesktopSettings(s);
    });
    window.electronAPI?.getDiagnosticLogPath?.().then(setDiagnosticLogPath).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isNative()) return;
    SkyeVoxNative.getDefaultCallingStatus()
      .then(setDefaultCallingStatus)
      .catch(() => {
        setDefaultCallingStatus({
          supported: false,
          eligible: false,
          enabled: false,
          reason: 'Native calling plugin is not available yet.',
        });
      });
  }, []);

  // Fetch DND state from the extension-authenticated Green API.
  useEffect(() => {
    setDndSyncing(false);
    setDndError(false);
    if (!sipConfig?.extension) return;
    let cancelled = false;
    fetchDndState(sipConfig)
      .then((enabled) => {
        if (cancelled || useStore.getState().sipConfig !== sipConfig) return;
        setDndEnabled(enabled);
        setDndError(false);
      })
      .catch((error) => {
        if (cancelled || useStore.getState().sipConfig !== sipConfig) return;
        console.warn('DND state request failed:', error);
        setDndError(true);
      });
    return () => { cancelled = true; };
  }, [setDndEnabled, sipConfig]);

  const handleDndToggle = () => {
    if (!sipConfig?.extension) return;
    const newValue = !dndEnabled;
    setDndSyncing(true);
    setDndError(false);
    updateDndState(sipConfig, newValue)
      .then((enabled) => {
        if (useStore.getState().sipConfig !== sipConfig) return;
        setDndEnabled(enabled);
        setDndError(false);
      })
      .catch((error) => {
        if (useStore.getState().sipConfig !== sipConfig) return;
        console.warn('DND state update failed:', error);
        setDndError(true);
      })
      .finally(() => {
        if (useStore.getState().sipConfig === sipConfig) setDndSyncing(false);
      });
  };

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
    Storage.set('skyevox_language', lang);
  };

  const handleScreenPopToggle = () => {
    const newVal = !screenPopEnabled;
    setScreenPopEnabled(newVal);
    Storage.set('skyevox_screen_pop_enabled', String(newVal));
  };

  const handlePushToggle = async () => {
    if (!sipConfig || pushBusy) return;
    setPushBusy(true);
    setPushError(null);
    try {
      if (pushSubscribed) {
        await disableBrowserPush(sipConfig);
        setPushSubscribed(false);
      } else {
        await enableBrowserPush(sipConfig);
        setPushSubscribed(true);
      }
    } catch (error) {
      setPushError(error instanceof Error ? error.message : t('settings.backgroundCallsFailed'));
    } finally {
      setPushBusy(false);
    }
  };

  const handleWebhookUrlChange = (url: string) => {
    setCrmWebhookUrl(url || null);
    Storage.set('skyevox_crm_webhook_url', url);
  };

  const handleAutoStartToggle = () => {
    const newVal = !desktopSettings.autoStart;
    setDesktopSettings((s) => ({ ...s, autoStart: newVal }));
    window.electronAPI?.setAutoStart(newVal);
  };

  const handleMinimizeToTrayToggle = () => {
    const newVal = !desktopSettings.minimizeToTray;
    setDesktopSettings((s) => ({ ...s, minimizeToTray: newVal }));
    window.electronAPI?.setMinimizeToTray(newVal);
  };

  const handleSpeakerTest = useCallback(async () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      setSpeakerTestState('error');
      return;
    }

    setSpeakerTestState('playing');
    let context: AudioContext | null = null;
    let audio: HTMLAudioElement | null = null;

    try {
      context = new AudioContextCtor() as AudioContext;
      const contextWithSink = context as AudioContext & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      const sinkId = audioOutputDevice && audioOutputDevice !== 'default' ? audioOutputDevice : '';
      if (contextWithSink.setSinkId) {
        await contextWithSink.setSinkId(sinkId).catch((error) => {
          void window.electronAPI?.logRenderer?.('warn', 'Speaker test AudioContext sink selection failed.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      const selectedVolume = Math.max(0, Math.min(Number(volume || 80), 100)) / 100;
      oscillator.type = 'sine';
      oscillator.frequency.value = 520;
      gain.gain.value = 0.16 * selectedVolume;
      oscillator.connect(gain);
      gain.connect(destination);

      if (isElectron()) {
        gain.connect(context.destination);
      }

      audio = new Audio();
      audio.autoplay = true;
      audio.volume = selectedVolume;
      audio.srcObject = destination.stream;
      const audioWithSink = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (audioWithSink.setSinkId) {
        await audioWithSink.setSinkId(sinkId).catch((error) => {
          void window.electronAPI?.logRenderer?.('warn', 'Speaker test audio element sink selection failed.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      await context.resume();
      oscillator.start();
      await audio.play();
      await new Promise((resolve) => setTimeout(resolve, 900));
      oscillator.stop();
      audio.pause();
      audio.srcObject = null;
      await context.close();
      setSpeakerTestState('ok');
      setTimeout(() => setSpeakerTestState('idle'), 2500);
    } catch (error) {
      audio?.pause();
      if (context && context.state !== 'closed') {
        await context.close().catch(() => {});
      }
      setSpeakerTestState('error');
      void window.electronAPI?.logRenderer?.('error', 'Speaker test failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [audioOutputDevice, volume]);

  const audioInputs = devices.filter(d => d.kind === 'audioinput');
  const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
  const selectedInputMissing = audioInputDevice !== 'default' && !audioInputs.some(d => d.deviceId === audioInputDevice);
  const selectedOutputMissing = audioOutputDevice !== 'default' && !audioOutputs.some(d => d.deviceId === audioOutputDevice);
  const nativePlatformName = isIos() ? 'iPhone' : isAndroid() ? 'Android' : 'Mobile';

  useEffect(() => {
    if (audioInputs.length > 0 && selectedInputMissing) {
      setAudioInputDevice('default');
    }
    if (audioOutputs.length > 0 && selectedOutputMissing) {
      setAudioOutputDevice('default');
    }
  }, [
    audioInputs.length,
    audioOutputs.length,
    selectedInputMissing,
    selectedOutputMissing,
    setAudioInputDevice,
    setAudioOutputDevice,
  ]);

  return (
    <div className="flex flex-col gap-4 p-3 overflow-y-auto max-h-[380px]">
      {/* Connection Status */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.status')}</h3>
        <div className="flex items-center gap-2 text-sm">
          <span className={`w-2 h-2 rounded-full ${registered ? 'bg-green-400' : 'bg-red-400'}`} aria-hidden="true" />
          <span className="text-gray-700">{registered ? t('settings.registered') : t('settings.notRegistered')}</span>
        </div>
        {sipConfig && (
          <div className="mt-1 space-y-0.5 text-xs text-gray-400">
            <div>{sipConfig.displayName} ({t('settings.ext', { ext: sipConfig.extension })})</div>
            <div>SIP domain: {sipConfig.sipDomain || sipConfig.sipServer}</div>
            <div>Registrar: {sipConfig.sipServer}</div>
          </div>
        )}
        {sipConfig && onEditRegistration && (
          <button
            onClick={onEditRegistration}
            className="mt-3 w-full rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-100"
          >
            Edit registration
          </button>
        )}
        {sipConfig?.embedded && onPhoneSignOut && (
          <button
            type="button"
            onClick={onPhoneSignOut}
            className="mt-3 w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
          >
            {t('settings.phoneSignOut')}
          </button>
        )}
      </div>

      {/* Account */}
      {!sipConfig?.embedded && (onSignOut || onResetApp) && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.account')}</h3>
          {onSignOut && sipConfig && (
            <button
              type="button"
              onClick={() => { if (window.confirm(t('settings.signOutConfirm'))) onSignOut(); }}
              className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
            >
              {t('settings.signOut')}
            </button>
          )}
          {onResetApp && (
            <button
              type="button"
              onClick={() => { if (window.confirm(t('settings.resetAppConfirm'))) onResetApp(); }}
              className="mt-3 w-full rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
            >
              {t('settings.resetApp')}
            </button>
          )}
          <p className="mt-2 text-xs text-gray-400">{t('settings.accountNote')}</p>
        </div>
      )}

      {/* Language */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.language')}</h3>
        <select
          value={i18n.language?.substring(0, 2) || 'en'}
          onChange={(e) => handleLanguageChange(e.target.value)}
          aria-label={t('settings.language')}
          className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none"
        >
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </div>

      {/* Do Not Disturb */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.dnd')}</h3>
        <button
          onClick={handleDndToggle}
          disabled={dndSyncing}
          aria-pressed={dndEnabled}
          aria-label={t('settings.dnd')}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors touch-target ${
            dndEnabled
              ? 'bg-red-50 border border-red-200'
              : 'bg-gray-50 border border-gray-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <svg
              className={`w-5 h-5 ${dndEnabled ? 'text-red-500' : 'text-gray-400'}`}
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-5-9h10v2H7z" />
            </svg>
            <span className={`text-sm font-medium ${dndEnabled ? 'text-red-600' : 'text-gray-700'}`}>
              {dndEnabled ? t('settings.dndEnabled') : t('settings.dndDisabled')}
            </span>
          </div>
          {/* Toggle switch */}
          <div
            className={`relative w-10 h-5 rounded-full transition-colors ${
              dndEnabled ? 'bg-red-500' : 'bg-gray-300'
            }`}
            aria-hidden="true"
          >
            <div
              className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                dndEnabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </div>
        </button>
        {dndEnabled && (
          <p className="text-xs text-red-400 mt-1 px-1">
            {t('settings.dndWarning')}
          </p>
        )}
        {dndError && (
          <p className="text-xs text-red-600 mt-1 px-1" role="alert">
            {t('settings.dndSyncError')}
          </p>
        )}
      </div>

      {/* Microphone */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.microphone')}</h3>
        <select
          value={audioInputDevice}
          onChange={(e) => setAudioInputDevice(e.target.value)}
          aria-label={t('settings.microphone')}
          className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none"
        >
          <option value="default">System default</option>
          {selectedInputMissing && (
            <option value={audioInputDevice}>Saved microphone unavailable</option>
          )}
          {audioInputs.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || t('settings.microphone')}</option>
          ))}
        </select>
      </div>

      {/* Speaker */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.speaker')}</h3>
        <select
          value={audioOutputDevice}
          onChange={(e) => setAudioOutputDevice(e.target.value)}
          aria-label={t('settings.speaker')}
          className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none"
        >
          <option value="default">System default</option>
          {selectedOutputMissing && (
            <option value={audioOutputDevice}>Saved speaker unavailable</option>
          )}
          {audioOutputs.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || t('settings.speaker')}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleSpeakerTest}
          disabled={speakerTestState === 'playing'}
          className="mt-2 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {speakerTestState === 'playing' ? t('settings.testingSpeaker') : t('settings.testSpeaker')}
        </button>
        {speakerTestState === 'ok' && (
          <p className="mt-1 px-1 text-xs text-green-600">{t('settings.speakerTestOk')}</p>
        )}
        {speakerTestState === 'error' && (
          <p className="mt-1 px-1 text-xs text-red-500">{t('settings.speakerTestFailed')}</p>
        )}
      </div>

      {/* Volume */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.volume')}</h3>
        <input
          type="range" min="0" max="100"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label={t('settings.volume')}
          className="w-full accent-sky-600"
        />
      </div>

      {/* Ringtone */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.ringtone')}</h3>
        <select
          value={ringtone}
          onChange={(e) => setRingtone(e.target.value)}
          aria-label={t('settings.ringtone')}
          className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none"
        >
          <option value="default">{t('settings.ringtoneDefault')}</option>
          <option value="classic">{t('settings.ringtoneClassic')}</option>
          <option value="digital">{t('settings.ringtoneDigital')}</option>
          <option value="soft">{t('settings.ringtoneSoft')}</option>
        </select>
      </div>

      {/* Native mobile calling */}
      {isNative() && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.mobileCalling')}</h3>
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <div className="font-semibold text-gray-800">{nativePlatformName}</div>
            <div className="mt-1">
              {defaultCallingStatus?.enabled
                ? t('settings.defaultCallingEnabled')
                : defaultCallingStatus?.eligible
                  ? t('settings.defaultCallingEligible')
                  : defaultCallingStatus?.supported === false
                    ? defaultCallingStatus.reason || t('settings.defaultCallingUnavailable')
                    : t('settings.defaultCallingChecking')}
            </div>
          </div>
          {isAndroid() && sipConfig && (
            <div className="mt-2">
              <label htmlFor="calling-engine" className="block text-xs text-gray-500 mb-1">{t('settings.engine')}</label>
              <select
                id="calling-engine"
                value={currentEngine}
                onChange={(e) => void handleEngineChange(e.target.value as 'liblinphone' | 'sipjs')}
                aria-label={t('settings.engine')}
                className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none"
              >
                <option value="liblinphone">{t('settings.engineNative')}</option>
                <option value="sipjs">{t('settings.engineWeb')}</option>
              </select>
              <p className="mt-1 px-1 text-xs text-gray-400">{t('settings.engineHint')}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => SkyeVoxNative.openDefaultCallingSettings().catch(() => {})}
            className="mt-2 w-full rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-100"
          >
            {t('settings.defaultCallingSettings')}
          </button>
        </div>
      )}

      {sipConfig?.embedded && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.backgroundCalls')}</h3>
          <button
            type="button"
            onClick={() => void handlePushToggle()}
            disabled={!pushSupported || pushBusy}
            aria-pressed={pushSubscribed}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors touch-target ${
              pushSubscribed ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <span className={`text-sm font-medium ${pushSubscribed ? 'text-green-700' : 'text-gray-700'}`}>
              {!pushSupported ? t('settings.backgroundCallsUnsupported') : pushSubscribed ? t('settings.backgroundCallsEnabled') : t('settings.backgroundCallsDisabled')}
            </span>
            <div className={`relative w-10 h-5 rounded-full transition-colors ${pushSubscribed ? 'bg-green-500' : 'bg-gray-300'}`} aria-hidden="true">
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${pushSubscribed ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
          </button>
          <p className="mt-1 px-1 text-xs text-gray-400">{t('settings.backgroundCallsHint')}</p>
          {pushError && <p className="mt-1 px-1 text-xs text-red-500" role="alert">{pushError}</p>}
        </div>
      )}

      {/* CRM Integration */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.crmIntegration')}</h3>
        <button
          onClick={handleScreenPopToggle}
          aria-pressed={screenPopEnabled}
          aria-label={t('settings.crmEnabled')}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors touch-target mb-2 ${
            screenPopEnabled
              ? 'bg-sky-50 border border-sky-200'
              : 'bg-gray-50 border border-gray-200'
          }`}
        >
          <span className={`text-sm font-medium ${screenPopEnabled ? 'text-sky-600' : 'text-gray-700'}`}>
            {t('settings.crmEnabled')}
          </span>
          <div
            className={`relative w-10 h-5 rounded-full transition-colors ${
              screenPopEnabled ? 'bg-sky-500' : 'bg-gray-300'
            }`}
            aria-hidden="true"
          >
            <div
              className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                screenPopEnabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </div>
        </button>
        {screenPopEnabled && (
          <input
            type="url"
            value={crmWebhookUrl || ''}
            onChange={(e) => handleWebhookUrlChange(e.target.value)}
            placeholder={t('settings.crmWebhookPlaceholder')}
            aria-label={t('settings.crmWebhookUrl')}
            className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm outline-none focus:ring-2 focus:ring-sky-300 border border-gray-200"
          />
        )}
      </div>

      {/* Desktop settings (Electron only) */}
      {isElectron() && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{t('settings.desktop')}</h3>
          <div className="space-y-2">
            <button
              onClick={handleAutoStartToggle}
              aria-pressed={desktopSettings.autoStart}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors touch-target ${
                desktopSettings.autoStart ? 'bg-sky-50 border border-sky-200' : 'bg-gray-50 border border-gray-200'
              }`}
            >
              <span className="text-sm text-gray-700">{t('settings.startAtLogin')}</span>
              <div className={`relative w-10 h-5 rounded-full transition-colors ${desktopSettings.autoStart ? 'bg-sky-500' : 'bg-gray-300'}`} aria-hidden="true">
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${desktopSettings.autoStart ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </button>
            <button
              onClick={handleMinimizeToTrayToggle}
              aria-pressed={desktopSettings.minimizeToTray}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors touch-target ${
                desktopSettings.minimizeToTray ? 'bg-sky-50 border border-sky-200' : 'bg-gray-50 border border-gray-200'
              }`}
            >
              <span className="text-sm text-gray-700">{t('settings.minimizeToTray')}</span>
              <div className={`relative w-10 h-5 rounded-full transition-colors ${desktopSettings.minimizeToTray ? 'bg-sky-500' : 'bg-gray-300'}`} aria-hidden="true">
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${desktopSettings.minimizeToTray ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </button>
          </div>
          {diagnosticLogPath && (
            <p className="mt-2 break-all px-1 text-xs text-gray-400">
              {t('settings.diagnosticsLog')}: {diagnosticLogPath}
            </p>
          )}
        </div>
      )}

      <div className="text-center text-xs text-gray-300 mt-2">
        {t('app.version', { version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '4.0' })}
      </div>
    </div>
  );
}
