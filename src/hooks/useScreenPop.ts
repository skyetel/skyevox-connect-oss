import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../platform';
import type { ScreenPopData, SipConfig } from '../types';
import { fetchDirectory } from '../api/directory';

interface ScreenPopOptions {
  callerNumber: string;
  extension: string;
  isInboundActive: boolean;
  enabled: boolean;
  webhookUrl: string | null;
  sipConfig?: SipConfig | null;
}

/**
 * Fetches caller info on inbound call establishment for CRM screen pops.
 */
export function useScreenPop({
  callerNumber,
  extension,
  isInboundActive,
  enabled,
  webhookUrl,
  sipConfig,
}: ScreenPopOptions) {
  const [data, setData] = useState<ScreenPopData | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isInboundActive || !enabled || !callerNumber || !extension) {
      return;
    }

    // Don't re-fetch for the same caller
    if (fetchedRef.current === callerNumber) return;
    fetchedRef.current = callerNumber;

    setLoading(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const fetchData = async () => {
      try {
        let result: ScreenPopData | null = null;
        if (sipConfig) {
          const entries = await fetchDirectory(sipConfig, controller.signal);
          const digits = callerNumber.replace(/\D/g, '');
          const match = digits
            ? entries.find((entry) => String(entry.number || entry.extension || '').replace(/\D/g, '') === digits)
            : undefined;
          result = match ? { found: true, name: match.name, email: match.email } : null;
        }

        // External webhook if configured
        if (webhookUrl) {
          try {
            const webhookRes = await fetch(
              apiUrl(sipConfig?.embedded ? `/api/connect/screen-pop/webhook-proxy?tenant=${encodeURIComponent(sipConfig.sipDomain || sipConfig.sipServer)}` : '/api/connect/screen-pop/webhook-proxy'),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  webhook_url: webhookUrl,
                  caller_number: callerNumber,
                  extension,
                }),
                signal: controller.signal,
              }
            );
            const webhook = await webhookRes.json();
            if (webhook && typeof webhook === 'object') {
              result = { ...result, ...webhook };
            }
          } catch {
            // Webhook failed, use internal data only
          }
        }

        setData(result);
      } catch {
        // Lookup failed — non-blocking
      } finally {
        clearTimeout(timeout);
        setLoading(false);
      }
    };

    fetchData();

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [isInboundActive, enabled, callerNumber, extension, webhookUrl, sipConfig]);

  // Reset when call ends
  useEffect(() => {
    if (!isInboundActive) {
      setData(null);
      fetchedRef.current = null;
    }
  }, [isInboundActive]);

  const dismiss = () => setData(null);

  return { data, loading, dismiss };
}
