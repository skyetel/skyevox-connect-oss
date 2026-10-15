import { sipConfigFromProvisioning } from './config.ts';
import type { SipConfig } from './types.ts';
import { normalizeRuntimeIceServers } from './sip/iceServers.ts';
declare global {
  interface Window {
    __SKYEVOX_EMBEDDED__?: { extensionId?: string };
  }
}

export function isEmbeddedWebPhone(search = window.location.search): boolean {
  return new URLSearchParams(search).get('embedded') === '1'
    || (typeof window !== 'undefined' && !!window.__SKYEVOX_EMBEDDED__);
}
export function resolveEmbeddedRequestURL(raw: string, locationHref: string, parentOrigin: string): URL {
  try {
    return new URL(raw, locationHref);
  } catch {
    if (!parentOrigin || parentOrigin === 'null') throw new Error('Web phone origin is unavailable.');
    return new URL(raw, `${parentOrigin.replace(/\/$/, '')}/`);
  }
}

export function normalizeEmbeddedWebSocketURL(raw: unknown, httpOrigin: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const candidate = value || '/ws';
  if (/^wss?:\/\//i.test(candidate)) {
    new URL(candidate);
    return candidate;
  }
  if (/^https?:\/\//i.test(candidate)) {
    const url = new URL(candidate);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
  if (candidate.startsWith('/')) {
    const url = new URL(candidate, httpOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
  return new URL(`wss://${candidate}`).toString();
}

function embeddedParentOrigin(): string {
  if (typeof window === 'undefined') return '';
  try {
    if (window.parent !== window && window.parent.location.origin) return window.parent.location.origin;
  } catch {
    // The embedded phone is same-origin in production; fall through defensively.
  }
  if (window.location.origin && window.location.origin !== 'null') return window.location.origin;
  try {
    return new URL(document.baseURI).origin;
  } catch {
    return '';
  }
}

let fetchContextInstalled = false;

export function installEmbeddedFetchContext(): void {
  if (fetchContextInstalled || !isEmbeddedWebPhone()) return;
  fetchContextInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const parentOrigin = embeddedParentOrigin();
    const url = resolveEmbeddedRequestURL(raw, window.location.href, parentOrigin);
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const requestInput = input instanceof Request ? input : url.toString();
    if (url.origin !== parentOrigin || method === 'GET' || method === 'HEAD') {
      return nativeFetch(requestInput, init);
    }
    const token = (document.cookie.match(/(?:^|;\s*)svx_csrf=([^;]*)/) || [])[1] || '';
    const next = { ...(init || {}), headers: new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)) };
    if (token) next.headers.set('X-CSRF-Token', token);
    return nativeFetch(requestInput, next);
  };
}

export async function loadEmbeddedSipConfig(search = window.location.search): Promise<SipConfig> {
  const params = new URLSearchParams(search);
  const extensionId = params.get('extension_id')
    || (typeof window !== 'undefined' ? window.__SKYEVOX_EMBEDDED__?.extensionId : undefined);
  const credentialPath = extensionId
    ? `/api/softphone/credentials/${encodeURIComponent(extensionId)}`
    : '/api/softphone/my-credentials';
  const [configResponse, credentialResponse] = await Promise.all([
    fetch('/api/softphone/config', { credentials: 'same-origin' }),
    fetch(credentialPath, { credentials: 'same-origin' }),
  ]);
  if (!configResponse.ok || !credentialResponse.ok) {
    throw new Error('Web phone credentials are unavailable for this session.');
  }
  const runtime = await configResponse.json();
  const credential = await credentialResponse.json();
  const iceServers = normalizeRuntimeIceServers(runtime.ice_servers);
  const turn = iceServers.find((entry) => (
    (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).some((url) => String(url).startsWith('turn'))
  ));
  const turnURL = turn
    ? (Array.isArray(turn.urls) ? turn.urls.find((url) => String(url).startsWith('turn')) || '' : turn.urls)
    : '';
  const httpOrigin = embeddedParentOrigin();
  const wssURL = normalizeEmbeddedWebSocketURL(runtime.wss_url, httpOrigin);
  const sipServer = typeof runtime.route_host === 'string' && runtime.route_host.trim()
    ? runtime.route_host.trim()
    : new URL(wssURL).hostname;
  return {
    ...sipConfigFromProvisioning({
      sip_domain: credential.domain_name,
      sip_server: sipServer,
      wss_url: wssURL,
      username: credential.extension,
      password: credential.password,
      display_name: credential.display_name,
      extension: credential.extension,
      sms_from: credential.sms_number,
      turn_server: turnURL,
      turn_credentials: { username: turn?.username || '', credential: turn?.credential || '' },
      register_interval: runtime.register_interval,
    }),
    iceServers,
    embedded: true,
    extensionId: Number(credential.id) || undefined,
    parkCode: runtime.park_code || '',
  };
}
