import { Capacitor } from '@capacitor/core';
import { API_BASE, SKYETEL_CONNECT_HOST } from './config';
import type { SipConfig } from './types';

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function isAndroid(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export function isIos(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

export function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

/**
 * Checks if running inside Electron desktop app.
 */
export function isElectron(): boolean {
  return !!window.electronAPI?.isElectron;
}

/**
 * Prepends the full API base URL on native platforms.
 * On web, returns the path as-is (relative fetch).
 */
export function apiUrl(path: string): string {
  if (isNative() || isElectron()) {
    return `${API_BASE}${path}`;
  }
  return path;
}

/**
 * Resolves the provisioning redemption URL for a scanned/linked token.
 * The skyevox:// QR carries the API host in its `server` parameter because
 * native builds cannot rely on a compiled-in origin (the SIP host and the
 * web/API host differ). Falls back to apiUrl() when no valid server is given.
 */
export function provisioningUrl(token: string, server?: string | null): string {
  const host = (server || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) {
    return `https://${host}/api/provisioning/${encodeURIComponent(token)}`;
  }
  return apiUrl(`/api/provisioning/${encodeURIComponent(token)}`);
}

function hostFromConfig(config?: SipConfig | null): string {
  const configuredHost = config?.sipServer || config?.wssUrl || '';
  if (!configuredHost) return '';

  try {
    const url = configuredHost.includes('://')
      ? new URL(configuredHost)
      : new URL(`https://${configuredHost}`);
    return url.hostname;
  } catch {
    return configuredHost
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[/:?#]/, 1)[0]
      .trim();
  }
}

export function apiUrlForConfig(path: string, config?: SipConfig | null): string {
  if (isNative() || isElectron()) {
    const apiBase = (config?.apiBase || '').trim().replace(/\/+$/, '');
    if (/^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/.test(apiBase)) {
      return `${apiBase}${path}`;
    }
    const host = hostFromConfig(config);
    return host && host !== SKYETEL_CONNECT_HOST ? `https://${host}${path}` : `${API_BASE}${path}`;
  }
  return path;
}
