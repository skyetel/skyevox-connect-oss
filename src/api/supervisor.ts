import { voicemailApiHeaders } from './voicemail.ts';
import type { SipConfig, SupervisorCapabilities, SupervisorLiveState } from '../types.ts';

const CONNECT_SUPERVISOR_ORIGIN = 'https://skyevox.skyetel.ai';

export type SupervisorAction = 'spy' | 'whisper' | 'barge' | 'hold' | 'unhold' | 'hangup' | 'transfer' | 'record_start' | 'record_stop';

function supervisorURL(config: SipConfig, action: 'capabilities' | 'live' | 'action'): string {
  return `${CONNECT_SUPERVISOR_ORIGIN}/api/connect/supervisor/${encodeURIComponent(config.extension)}/${action}`;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string' && body.error) return new Error(body.error);
  } catch {
    // Use the stable fallback below.
  }
  return new Error(fallback);
}

export async function fetchSupervisorCapabilities(config: SipConfig): Promise<SupervisorCapabilities> {
  const response = await fetch(supervisorURL(config, 'capabilities'), { headers: voicemailApiHeaders(config), cache: 'no-store' });
  if (!response.ok) throw await responseError(response, `Supervisor capabilities failed: ${response.status}`);
  return response.json() as Promise<SupervisorCapabilities>;
}

export async function fetchSupervisorLive(config: SipConfig): Promise<SupervisorLiveState> {
  const response = await fetch(supervisorURL(config, 'live'), { headers: voicemailApiHeaders(config), cache: 'no-store' });
  if (!response.ok) throw await responseError(response, `Supervisor live state failed: ${response.status}`);
  return response.json() as Promise<SupervisorLiveState>;
}

export async function runSupervisorAction(config: SipConfig, uuid: string, action: SupervisorAction, destination = ''): Promise<{ message: string }> {
  const response = await fetch(supervisorURL(config, 'action'), {
    method: 'POST',
    headers: { ...voicemailApiHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid, action, destination }),
  });
  if (!response.ok) throw await responseError(response, `Supervisor action failed: ${response.status}`);
  return response.json() as Promise<{ message: string }>;
}
