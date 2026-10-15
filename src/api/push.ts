import type { SipConfig } from '../types';

const PUSH_API = '/api/connect/push';

export interface BrowserPushState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

function pushScope(config: SipConfig): string {
  return `tenant=${encodeURIComponent(config.sipDomain || config.sipServer)}`;
}

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Background call alerts are not supported by this browser.');
  }
  return navigator.serviceWorker.register('/connect/connect-sw.js', { scope: '/connect/' });
}

export async function browserPushState(): Promise<BrowserPushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  const worker = await registration();
  return { supported: true, permission: Notification.permission, subscribed: !!await worker.pushManager.getSubscription() };
}

export async function enableBrowserPush(config: SipConfig): Promise<void> {
  if (!config.embedded || !config.extensionId) throw new Error('A session extension is required.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  const worker = await registration();
  const keyResponse = await fetch(`${PUSH_API}/key`, { credentials: 'same-origin' });
  if (!keyResponse.ok) throw new Error('Background call alerts are unavailable.');
  const { public_key: publicKey } = await keyResponse.json();
  let subscription = await worker.pushManager.getSubscription();
  if (!subscription) {
    subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeApplicationServerKey(publicKey) });
  }
  const serialized = subscription.toJSON();
  const response = await fetch(`${PUSH_API}/subscription?${pushScope(config)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extension: config.extension, extension_id: config.extensionId, endpoint: subscription.endpoint, keys: serialized.keys }),
  });
  if (!response.ok) {
    await subscription.unsubscribe().catch(() => false);
    throw new Error('Unable to save background call alerts.');
  }
}

export async function disableBrowserPush(config: SipConfig): Promise<void> {
  const worker = await registration();
  const subscription = await worker.pushManager.getSubscription();
  if (!subscription) return;
  let response: Response;
  try {
    response = await fetch(`${PUSH_API}/subscription?${pushScope(config)}`, {
      method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension: config.extension, endpoint: subscription.endpoint, keys: {} }),
    });
  } finally {
    await subscription.unsubscribe().catch(() => false);
  }
  if (!response.ok) throw new Error('Unable to remove background call alerts.');
}

export async function claimPendingBrowserCalls(config: SipConfig): Promise<number> {
  if (!config.embedded || !config.extension) return 0;
  const query = `?extension=${encodeURIComponent(config.extension)}&${pushScope(config)}`;
  const response = await fetch(`${PUSH_API}/reservations${query}`, { credentials: 'same-origin' });
  if (!response.ok) return 0;
  const reservations = await response.json();
  if (!Array.isArray(reservations)) return 0;

  let claimed = 0;
  for (const reservation of reservations) {
    const claim = await fetch(`${PUSH_API}/reservations/${encodeURIComponent(reservation.id)}/claim${query}`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (claim.ok) claimed += 1;
  }
  return claimed;
}
export function startBrowserPushHeartbeat(config: SipConfig): () => void {
  if (!config.embedded || !config.extension) return () => {};
  const query = `?extension=${encodeURIComponent(config.extension)}&${pushScope(config)}`;
  const beat = () => {
    void fetch(`${PUSH_API}/heartbeat${query}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  };
  beat();
  const interval = window.setInterval(beat, 5000);
  window.addEventListener('online', beat);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener('online', beat);
  };
}
