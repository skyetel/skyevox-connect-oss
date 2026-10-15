import { voicemailApiHeaders, voicemailApiUrl } from './voicemail.ts';
import type { SipConfig } from '../types.ts';

export async function syncLocalConference(config: SipConfig, callIds: string[], active: boolean): Promise<void> {
  if (callIds.length !== 2 || new Set(callIds).size !== 2 || callIds.some((id) => !id)) {
    throw new Error('Conference requires two established SIP dialogs.');
  }
  const response = await fetch(voicemailApiUrl(`/api/connect/conference/${encodeURIComponent(config.extension)}`), {
    method: active ? 'POST' : 'DELETE',
    headers: { ...voicemailApiHeaders(config), 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ call_ids: callIds }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.error || `Conference synchronization failed (HTTP ${response.status}).`);
  }
}
