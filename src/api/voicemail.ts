import type { SipConfig } from '../types';

const VOICEMAIL_API_BASE = 'https://skyevox.skyetel.ai';

export function voicemailApiUrl(path: string): string {
  return `${VOICEMAIL_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export function voicemailApiHeaders(config: SipConfig): { Authorization: string } {
  const tenant = config.sipDomain?.trim();
  if (!tenant) throw new Error('SIP domain is required for voicemail');
  const credentials = `${config.extension}@${tenant}:${config.password}`;
  const bytes = new TextEncoder().encode(credentials);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { Authorization: `Basic ${btoa(binary)}` };
}

export async function fetchVoicemailAudio(config: SipConfig, messageId: string): Promise<Blob> {
  const response = await fetch(
    voicemailApiUrl(`/api/connect/voicemail/${encodeURIComponent(config.extension)}/${encodeURIComponent(messageId)}/audio`),
    { headers: voicemailApiHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(`Voicemail audio request failed: ${response.status}`);
  }
  return response.blob();
}

export async function deleteVoicemail(config: SipConfig, messageId: string): Promise<void> {
  const response = await fetch(
    voicemailApiUrl(`/api/connect/voicemail/${encodeURIComponent(config.extension)}/${encodeURIComponent(messageId)}`),
    { method: 'DELETE', headers: voicemailApiHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(`Voicemail delete request failed: ${response.status}`);
  }
}

export async function markVoicemailRead(config: SipConfig, messageId: string): Promise<void> {
  const response = await fetch(
    voicemailApiUrl(`/api/connect/voicemail/${encodeURIComponent(config.extension)}/${encodeURIComponent(messageId)}/read`),
    { method: 'POST', headers: voicemailApiHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(`Voicemail read update failed: ${response.status}`);
  }
}
