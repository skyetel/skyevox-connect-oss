import { apiUrlForConfig } from '../platform';
import type { SipConfig } from '../types';

export interface MobileDeviceRegistration {
  deviceId: string;
  platform: 'ios' | 'android' | 'web';
  appVersion?: string;
  osVersion?: string;
  deviceName?: string;
  pushProvider?: 'apns' | 'apns-voip' | 'fcm' | 'none';
  pushToken?: string;
  bundleId?: string;
  capabilities: {
    /** Native SIP engine in use on this device: liblinphone (Android native bridge) or sipjs. */
    engine: 'liblinphone' | 'sipjs';
    callkit?: boolean;
    androidTelecom?: boolean;
    defaultCallingEligible: boolean;
    sms: boolean;
    mms: boolean;
  };
}

export interface MobileDeviceRegistrationResponse {
  ok: boolean;
  deviceId: string;
  serverDeviceId?: number;
  registrationTtlSeconds: number;
  pushPolicy: 'wake-and-register' | 'always-registered';
  nativeSip: {
    registrar: string;
    outboundProxy: string;
    keepAliveSeconds: number;
    transport: 'tcp' | 'udp' | 'tls';
  };
}

function domainQuery(config: SipConfig): string {
  return `domain=${encodeURIComponent(config.sipDomain || config.sipServer)}`;
}

export async function registerMobileDevice(
  config: SipConfig,
  request: MobileDeviceRegistration,
): Promise<MobileDeviceRegistrationResponse> {
  const extension = encodeURIComponent(config.extension);
  const response = await fetch(
    apiUrlForConfig(`/api/connect/mobile/${extension}/register-device?${domainQuery(config)}`, config),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `Mobile registration failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<MobileDeviceRegistrationResponse>;
}

export async function unregisterMobileDevice(
  config: SipConfig,
  request: MobileDeviceRegistration,
): Promise<void> {
  const extension = encodeURIComponent(config.extension);
  await fetch(
    apiUrlForConfig(`/api/connect/mobile/${extension}/unregister-device?${domainQuery(config)}`, config),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
}
