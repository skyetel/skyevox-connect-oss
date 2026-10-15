import type { SipConfig } from './types';

export function connectScopeQuery(config?: SipConfig | null): string {
  if (!config) return '';
  const params = new URLSearchParams();
  if (config.extension) {
    params.set('extension', config.extension);
  }
  if (config.sipDomain) {
    params.set('domain', config.sipDomain);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
