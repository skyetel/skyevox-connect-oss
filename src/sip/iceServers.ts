import type { SipConfig } from '../types.ts';

function normalizeIceURL(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || /\s/.test(url) || !/^(stun|stuns|turn|turns):/i.test(url)) return null;
  if (/^stuns?:/i.test(url)) return url.replace(/\?.*$/, '');
  return url;
}

export function normalizeRuntimeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];
  const servers: RTCIceServer[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || !('urls' in candidate)) continue;
    const rawURLs = candidate.urls;
    const normalized = Array.isArray(rawURLs)
      ? rawURLs.map(normalizeIceURL).filter((url): url is string => !!url)
      : normalizeIceURL(rawURLs);
    if (!normalized || (Array.isArray(normalized) && normalized.length === 0)) continue;
    const server: RTCIceServer = { urls: normalized };
    const usesTURN = (Array.isArray(normalized) ? normalized : [normalized]).some((url) => /^turns?:/i.test(url));
    if (usesTURN && 'username' in candidate && typeof candidate.username === 'string' && candidate.username) {
      server.username = candidate.username;
    }
    if (usesTURN && 'credential' in candidate && typeof candidate.credential === 'string' && candidate.credential) {
      server.credential = candidate.credential;
    }
    servers.push(server);
  }
  return servers;
}

export function resolveIceServers(config: Pick<SipConfig, 'iceServers' | 'turnServer' | 'turnCredentials'>): RTCIceServer[] {
  const configured = normalizeRuntimeIceServers(config.iceServers);
  if (configured.length > 0) return configured;

  const turnServer = config.turnServer?.trim();
  if (!turnServer || !/^turns?:/i.test(turnServer) || /\s/.test(turnServer)) return [];
  const stunServer = turnServer.replace(/^turns?:/i, 'stun:').replace(/\?.*$/, '');
  const servers: RTCIceServer[] = [{ urls: stunServer }];
  const username = config.turnCredentials?.username?.trim();
  const credential = config.turnCredentials?.credential?.trim();
  if (username && credential) {
    servers.push({ urls: turnServer, username, credential });
  }
  return servers;
}
