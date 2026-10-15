import { useState, useEffect, useCallback } from 'react';
import { voicemailApiUrl } from '../api/voicemail';
import type { VersionInfo } from '../types';

declare const __APP_VERSION__: string;

const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Checks for app updates on startup and periodically.
 */
export function useAutoUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const checkVersion = useCallback(async () => {
    try {
      const res = await fetch(voicemailApiUrl('/api/connect/version/latest'));
      if (!res.ok) throw new Error(`Version check failed: ${res.status}`);
      const data: VersionInfo = await res.json();
      if (data.version && compareSemver(data.version, __APP_VERSION__) > 0) {
        setVersionInfo(data);
        setUpdateAvailable(true);
      }
    } catch {
      // Version check failed silently
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(checkVersion, 0);
    const interval = setInterval(checkVersion, CHECK_INTERVAL);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [checkVersion]);

  const dismiss = () => setDismissed(true);

  return {
    updateAvailable: updateAvailable && !dismissed,
    versionInfo,
    dismiss,
    mandatory: versionInfo?.mandatory ?? false,
  };
}
