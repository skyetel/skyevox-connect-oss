import { useEffect, useRef } from 'react';

/**
 * Traps Tab/Shift+Tab focus within a container element.
 * Attach the returned ref to the modal/dialog container.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const getFocusable = () =>
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);

    // Auto-focus first focusable element
    const focusable = getFocusable();
    if (focusable.length > 0) {
      setTimeout(() => focusable[0].focus(), 50);
    }

    return () => container.removeEventListener('keydown', handleKeyDown);
  }, []);

  return ref;
}
