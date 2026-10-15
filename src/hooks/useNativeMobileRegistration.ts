import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { registerMobileDevice } from '../api/mobile';
import { SkyeVoxNative } from '../native/SkyeVoxNative';
import { isAndroid, isIos, isNative } from '../platform';
import { NATIVE_ENGINE, platformUsesNativeEngine } from '../nativeEnginePolicy';
import { Storage } from '../storage';
import type { SipConfig } from '../types';

declare const __APP_VERSION__: string;

const DEVICE_ID_KEY = 'skyevox_connect_device_id';
const BUNDLE_ID = 'com.skyetel.skyevoxconnect';

async function getDeviceId(): Promise<string> {
  const existing = await Storage.get(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await Storage.set(DEVICE_ID_KEY, id);
  return id;
}

function pushProvider(): 'apns-voip' | 'fcm' | 'none' {
  if (isIos()) return 'apns-voip';
  if (isAndroid()) return 'fcm';
  return 'none';
}

export function useNativeMobileRegistration(sipConfig: SipConfig | null) {
  useEffect(() => {
    if (!sipConfig || !isNative()) return;

    const config = sipConfig;
    let cancelled = false;
    let registrationToken = '';
    let nativeTokenListener: PluginListenerHandle | null = null;
    let fallbackTimer: number | undefined;
    const nativeEngine = platformUsesNativeEngine(Capacitor.getPlatform(), config.mobile?.engine);

    async function register(pushToken?: string) {
      const deviceId = await getDeviceId();
      if (cancelled) return;

      await registerMobileDevice(config, {
        deviceId,
        platform: Capacitor.getPlatform() as 'ios' | 'android',
        appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
        pushProvider: pushToken ? pushProvider() : 'none',
        pushToken,
        bundleId: BUNDLE_ID,
        capabilities: {
          engine: nativeEngine ? NATIVE_ENGINE : 'sipjs',
          callkit: isIos() && nativeEngine,
          androidTelecom: isAndroid(),
          defaultCallingEligible: isAndroid() && Boolean(config.mobile?.defaultCallingEligible),
          sms: Boolean(config.mobile?.smsEnabled),
          mms: Boolean(config.mobile?.mmsEnabled),
        },
      });
    }

    async function handoffPushToken(token: string) {
      // The native engine puts the token into the RFC 8599 Contact params (pn-provider/pn-prid/pn-param)
      // so the Flexisip push gateway can wake this device. configure() is idempotent and keeps the
      // current registration state, so it is safe whether or not NativeSipClient connected already.
      if (!nativeEngine || pushProvider() !== 'fcm') return;
      await SkyeVoxNative.configure({ config: { ...config, pushToken: token, pushProvider: 'fcm' } });
    }

    async function start() {
      try {
        if (config.mobile?.pushEnabled) {
          if (nativeEngine && isIos()) {
            // iOS call wake-ups use PushKit VoIP tokens, which only the native engine sees
            // (PushKitBridge owns the registry and LinphoneEngine puts the token into the Contact
            // pn-prid itself). The plugin retains the event until a listener consumes it.
            nativeTokenListener = await SkyeVoxNative.addListener('pushTokenChanged', (event) => {
              if (event.platform !== 'ios' || !event.token) return;
              registrationToken = event.token;
              clearTimeout(fallbackTimer);
              register(event.token).catch((error) => {
                console.warn('SkyeVox mobile registration failed:', error);
              });
            });
            // No VoIP token (simulator, missing aps-environment): still register the device.
            fallbackTimer = window.setTimeout(() => {
              if (!registrationToken) register().catch(() => {});
            }, 5000);
            return;
          }
          const permission = await PushNotifications.requestPermissions();
          if (permission.receive === 'granted') {
            await PushNotifications.addListener('registration', (token) => {
              registrationToken = token.value;
              handoffPushToken(token.value).catch((error) => {
                console.warn('SkyeVox native push token handoff failed:', error);
              });
              register(token.value).catch((error) => {
                console.warn('SkyeVox mobile registration failed:', error);
              });
            });
            await PushNotifications.addListener('registrationError', (error) => {
              console.warn('SkyeVox push registration failed:', error);
              register().catch(() => {});
            });
            await PushNotifications.register();
            return;
          }
        }

        await register();
      } catch (error) {
        console.warn('SkyeVox native mobile setup failed:', error);
      }
    }

    start();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      if (registrationToken) {
        // Keep the server contact active until the platform tells us the app is
        // removed. A transient React unmount should not disable push wakeups.
      }
      nativeTokenListener?.remove().catch(() => {});
      PushNotifications.removeAllListeners().catch(() => {});
    };
  }, [sipConfig]);
}
