import type { SipConfig } from './types';

export const SKYETEL_CONNECT_HOST = 'connect.skyetel.ai';
const LEGACY_CONNECT_HOST = 'connect.skyetel.money';
export const CONNECT_API_ORIGIN = `https://${LEGACY_CONNECT_HOST}`;
export const API_BASE = CONNECT_API_ORIGIN;
export const DEFAULT_PARK_CODE = '6000';

export const DEFAULT_MANUAL_CONFIG = {
  sipDomain: '',
  sipServer: SKYETEL_CONNECT_HOST,
  wssUrl: `wss://${SKYETEL_CONNECT_HOST}:8443`,
  turnServer: `turn:${SKYETEL_CONNECT_HOST}:3478`,
};

interface ProvisioningPayload {
  sip_domain?: string;
  tenant_domain?: string;
  domain?: string;
  sip_server?: string;
  api_base?: string;
  wss_url?: string;
  username?: string;
  password?: string;
  display_name?: string;
  extension?: string;
  sms_from?: string;
  sms_did?: string;
  messaging_did?: string;
  turn_server?: string;
  turn_credentials?: SipConfig['turnCredentials'];
  srtp?: string;
  register_interval?: number;
  park_code?: string;
  mobile?: SipConfig['mobile'];
}

function normalizeHost(value: string | undefined, fallback: string): string {
  return (value || fallback).replaceAll(LEGACY_CONNECT_HOST, SKYETEL_CONNECT_HOST);
}

export function normalizeSipHost(value: string | undefined, fallback = ''): string {
  let host = normalizeHost(value, fallback).trim();

  if (host.toLowerCase().startsWith('sip:')) {
    host = host.slice(4);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).host;
    } catch {
      host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    }
  }

  if (host.includes('@')) {
    host = host.split('@').pop() || '';
  }

  return host.split(/[/?#]/, 1)[0].trim();
}

export function normalizeSipUser(value: string | undefined): string {
  let user = (value || '').trim();
  if (user.toLowerCase().startsWith('sip:')) {
    user = user.slice(4);
  }
  if (user.includes('@')) {
    user = user.split('@')[0];
  }
  return user.replace(/\s+/g, '');
}

export function normalizeSmsNumber(value: string | undefined): string | undefined {
  const trimmed = (value || '').trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return digits;
}

export function sipConfigFromProvisioning(data: ProvisioningPayload): SipConfig {
  return normalizeSipConfig({
    sipDomain: data.sip_domain || data.tenant_domain || data.domain || data.sip_server,
    sipServer: data.sip_server || DEFAULT_MANUAL_CONFIG.sipServer,
    wssUrl: data.wss_url || DEFAULT_MANUAL_CONFIG.wssUrl,
    username: data.username || '',
    password: data.password || '',
    displayName: data.display_name || data.extension || '',
    extension: data.extension || data.username || '',
    smsFrom: data.sms_from || data.sms_did || data.messaging_did,
    apiBase: data.api_base,
    turnServer: data.turn_server || DEFAULT_MANUAL_CONFIG.turnServer,
    turnCredentials: data.turn_credentials || { username: '', credential: '' },
    srtp: data.srtp || 'opportunistic',
    registerInterval: data.register_interval || 300,
    mobile: data.mobile,
    parkCode: data.park_code,
  });
}

export function normalizeSipConfig(config: SipConfig): SipConfig {
  const sipServer = normalizeSipHost(config.sipServer, DEFAULT_MANUAL_CONFIG.sipServer);
  const sipDomain = config.sipDomain
    ? normalizeSipHost(config.sipDomain, sipServer)
    : sipServer;
  const username = normalizeSipUser(config.username);
  // Older saved/manual profiles sometimes put a display name in Extension.
  // Recover only from a valid SIP identity; never overwrite a valid, distinct
  // numeric extension with an authentication username.
  const configuredExtension = config.extension?.trim() || '';
  const extension = /^[0-9]{1,10}$/.test(configuredExtension)
    ? configuredExtension
    : /^[0-9]{1,10}$/.test(username) ? username : configuredExtension;

  return {
    ...config,
    sipDomain,
    sipServer,
    username,
    extension,
    smsFrom: normalizeSmsNumber(config.smsFrom),
    wssUrl: normalizeHost(config.wssUrl, DEFAULT_MANUAL_CONFIG.wssUrl),
    turnServer: normalizeHost(config.turnServer, DEFAULT_MANUAL_CONFIG.turnServer),
    turnCredentials: config.turnCredentials || { username: '', credential: '' },
    srtp: config.srtp || 'opportunistic',
    registerInterval: config.registerInterval || 300,
    parkCode: config.parkCode?.trim() || DEFAULT_PARK_CODE,
  };
}
