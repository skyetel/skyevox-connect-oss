import { useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import { isNative } from '../platform';

/**
 * Manages app lifecycle on native platforms:
 * - Android back button handling
 * - App state change events (foreground/background)
 */
export function useAppLifecycle(callbacks?: {
  onBackButton?: () => void;
  onResume?: () => void;
  onPause?: () => void;
}) {
  useEffect(() => {
    if (!isNative()) return;

    // Android back button
    const backHandler = CapApp.addListener('backButton', ({ canGoBack }) => {
      if (callbacks?.onBackButton) {
        callbacks.onBackButton();
      } else if (canGoBack) {
        window.history.back();
      } else {
        CapApp.minimizeApp();
      }
    });

    // App state changes
    const stateHandler = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        callbacks?.onResume?.();
      } else {
        callbacks?.onPause?.();
      }
    });

    return () => {
      backHandler.then((h) => h.remove());
      stateHandler.then((h) => h.remove());
    };
  }, [callbacks]);
}
