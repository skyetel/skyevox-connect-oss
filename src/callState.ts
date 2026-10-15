import type { CallState } from './types';

export function usesActiveCallControls(status: CallState['status']): boolean {
  return ['dialing', 'active', 'held'].includes(status);
}
