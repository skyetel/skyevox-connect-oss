import { useEffect } from 'react';

interface KeyboardNavHandlers {
  onDial?: () => void;
  onAnswer?: () => void;
  onHangup?: () => void;
  onDTMF?: (digit: string) => void;
  onMuteToggle?: () => void;
  onHoldToggle?: () => void;
  isInCall: boolean;
  hasIncoming: boolean;
}

/**
 * Global keyboard shortcuts for call control.
 */
export function useKeyboardNav({
  onDial,
  onAnswer,
  onHangup,
  onDTMF,
  onMuteToggle,
  onHoldToggle,
  isInCall,
  hasIncoming,
}: KeyboardNavHandlers) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Enter') {
        if (hasIncoming) {
          e.preventDefault();
          onAnswer?.();
        } else if (!isInCall) {
          e.preventDefault();
          onDial?.();
        }
        return;
      }

      if (e.key === 'Escape') {
        if (isInCall) {
          e.preventDefault();
          onHangup?.();
        }
        return;
      }

      if (isInCall) {
        // DTMF digits during call
        if (/^[0-9*#]$/.test(e.key)) {
          e.preventDefault();
          onDTMF?.(e.key);
          return;
        }

        // M = mute toggle
        if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          onMuteToggle?.();
          return;
        }

        // H = hold toggle
        if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          onHoldToggle?.();
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDial, onAnswer, onHangup, onDTMF, onMuteToggle, onHoldToggle, isInCall, hasIncoming]);
}
