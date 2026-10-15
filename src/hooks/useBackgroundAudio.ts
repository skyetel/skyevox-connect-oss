import { useEffect, useRef } from 'react';

/**
 * Keeps audio alive during calls by acquiring a WakeLock (web)
 * and preventing the screen from sleeping.
 * The native liblinphone engine owns Android background audio. SIP.js platforms, including
 * foreground iOS, retain the web wake-lock path instead of assuming an
 * unimplemented native iOS audio engine exists.
 */
export function useBackgroundAudio(inCall: boolean, nativeAudioManaged = false) {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!inCall) {
      // Release wake lock when call ends
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      return;
    }

    // Only the implemented native liblinphone engine owns its background lifecycle.
    if (nativeAudioManaged) return;

    // On web, use WakeLock API to prevent screen sleep during call
    async function acquireWakeLock() {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch {
        // WakeLock not supported or denied
      }
    }

    acquireWakeLock();

    // Re-acquire wake lock if page becomes visible again
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && inCall) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [inCall]);
}
