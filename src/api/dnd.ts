import type { SipConfig } from '../types.ts';
import { voicemailApiHeaders, voicemailApiUrl } from './voicemail.ts';

function request(config: SipConfig): { url: string; headers: Record<string, string> } {
  const extension = encodeURIComponent(config.extension);
  if (config.embedded) {
    const tenant = encodeURIComponent(config.sipDomain || config.sipServer);
    return {
      url: `/api/connect/web/dnd/${extension}?tenant=${tenant}`,
      headers: {},
    };
  }
  return {
    url: voicemailApiUrl(`/api/connect/dnd/${extension}`),
    headers: voicemailApiHeaders(config),
  };
}

async function enabledFromResponse(response: Response, operation: string): Promise<boolean> {
  if (!response.ok) throw new Error(`DND state ${operation} failed: ${response.status}`);
  const data = await response.json() as { enabled?: unknown };
  if (typeof data.enabled !== 'boolean') throw new Error(`DND state ${operation} returned an invalid response.`);
  return data.enabled;
}

export async function fetchDndState(config: SipConfig): Promise<boolean> {
  const { url, headers } = request(config);
  return enabledFromResponse(await fetch(url, { headers, cache: 'no-store' }), 'request');
}

export async function updateDndState(config: SipConfig, enabled: boolean): Promise<boolean> {
  const { url, headers } = request(config);
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return enabledFromResponse(response, 'update');
}
