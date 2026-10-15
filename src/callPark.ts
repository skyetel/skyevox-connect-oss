import { voicemailApiHeaders, voicemailApiUrl } from './api/voicemail.ts';
import type { ParkSlot, SipConfig } from './types.ts';

const FIRST_VALET_SLOT = 6001;
const LAST_VALET_SLOT = 6099;
const PARK_FEATURE_PREFIX = '*68*';
const PICKUP_FEATURE_PREFIX = '*69*';

export interface ParkResult {
  slot: number;
  featureCode: string;
}
type ParkTransfer = (destination: string) => Promise<void>;

type ParkFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ParkPayload {
  slot?: unknown;
  feature_code?: unknown;
  detail?: unknown;
  error?: unknown;
}

function parkApiUrl(config: SipConfig, suffix = ''): string {
  const extension = config.extension.trim();
  if (!extension) throw new Error('Call park requires an extension.');
  return voicemailApiUrl(`/api/connect/park/${encodeURIComponent(extension)}${suffix}`);
}

function payloadError(payload: ParkPayload | null, status: number): string {
  return typeof payload?.detail === 'string'
    ? payload.detail
    : typeof payload?.error === 'string'
      ? payload.error
      : `Call park failed (${status}).`;
}

function validatedParkResult(slot: unknown, featureCode: unknown): ParkResult {
  const slotNumber = Number(slot);
  const destination = typeof featureCode === 'string' ? featureCode.trim() : '';
  if (
    !Number.isInteger(slotNumber)
    || slotNumber < FIRST_VALET_SLOT
    || slotNumber > LAST_VALET_SLOT
    || destination !== `${PARK_FEATURE_PREFIX}${slotNumber}`
  ) {
    throw new Error('Call park returned an invalid parking slot.');
  }
  return { slot: slotNumber, featureCode: destination };
}

export async function requestCallPark(
  config: SipConfig,
  fetcher: ParkFetch = fetch,
): Promise<ParkResult> {
  const response = await fetcher(parkApiUrl(config), {
    method: 'POST',
    headers: voicemailApiHeaders(config),
  });
  const payload = await response.json().catch(() => null) as ParkPayload | null;

  if (!response.ok) {
    throw new Error(payloadError(payload, response.status));
  }
  return validatedParkResult(payload?.slot, payload?.feature_code);
}
export async function parkActiveCall(
  config: SipConfig,
  transfer: ParkTransfer,
  fetcher: ParkFetch = fetch,
): Promise<ParkResult> {
  const result = await requestCallPark(config, fetcher);
  await transfer(result.featureCode);
  return result;
}


export async function fetchCallParkSlots(
  config: SipConfig,
  fetcher: ParkFetch = fetch,
): Promise<ParkSlot[]> {
  const response = await fetcher(parkApiUrl(config, '/slots'), {
    headers: voicemailApiHeaders(config),
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new Error(payloadError(payload as ParkPayload | null, response.status));
  }
  if (!Array.isArray(payload)) {
    throw new Error('Call park returned an invalid slot list.');
  }
  return payload.filter((slot): slot is ParkSlot => {
    if (slot === null || typeof slot !== 'object') return false;
    const candidate = slot as ParkSlot;
    return (
      Number.isInteger(candidate.slot)
      && candidate.slot >= FIRST_VALET_SLOT
      && candidate.slot <= LAST_VALET_SLOT
      && typeof candidate.caller_id === 'string'
      && typeof candidate.caller_name === 'string'
      && candidate.pickup_code === `${PICKUP_FEATURE_PREFIX}${candidate.slot}`
      && typeof candidate.uuid === 'string' && candidate.uuid.length > 0
      && typeof candidate.node === 'string' && candidate.node.length > 0
    );
  });
}

export async function pickupParkedCall(
  config: SipConfig,
  uuid: string,
  fetcher: ParkFetch = fetch,
): Promise<void> {
  const response = await fetcher(parkApiUrl(config, '/pickup'), {
    method: 'POST',
    headers: { ...voicemailApiHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid }),
  });
  const payload = await response.json().catch(() => null) as (ParkPayload & { ok?: boolean }) | null;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payloadError(payload, response.status));
  }
}
