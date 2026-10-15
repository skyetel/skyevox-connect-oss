import type { SipConfig } from './types';
import { provisioningUrl } from './platform';
import { Storage } from './storage';
import { sipConfigFromProvisioning } from './config';

/**
 * Handle skyevox:// deep link provisioning.
 * Called when app is opened via skyevox://provision?token=xxx&server=host.
 * The server parameter names the HTTPS API host that minted the token; it is
 * required on native builds, where no same-origin fallback exists.
 */
export async function handleDeepLink(
  url: string,
  onConfig: (config: SipConfig) => void,
  onError?: (message: string) => void,
): Promise<void> {
  try {
    const parsed = new URL(url);
    // skyevox://provision?token=xxx&server=host
    if (parsed.hostname === 'provision' || parsed.pathname === '/provision') {
      const token = parsed.searchParams.get('token');
      if (!token) return;

      const response = await fetch(provisioningUrl(token, parsed.searchParams.get('server')));
      if (!response.ok) {
        const body = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `provisioning failed (HTTP ${response.status})`);
      }
      const data = await response.json();

      const sipConfig = sipConfigFromProvisioning(data);

      await Storage.set('skyevox_config', JSON.stringify(sipConfig));
      onConfig(sipConfig);
    }
  } catch (err) {
    console.error('Deep link handling failed:', err);
    onError?.(err instanceof Error ? err.message : 'Provisioning failed.');
  }
}
