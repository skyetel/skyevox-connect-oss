import { useEffect, useRef, useCallback } from 'react';

/**
 * Creates a hidden aria-live region for screen reader announcements.
 * Returns an announce() function to push messages.
 */
export function useAnnouncer() {
  const elRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', 'status');
    Object.assign(el.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0,0,0,0)',
      whiteSpace: 'nowrap',
      border: '0',
    });
    document.body.appendChild(el);
    elRef.current = el;

    return () => {
      document.body.removeChild(el);
      elRef.current = null;
    };
  }, []);

  const announce = useCallback((message: string) => {
    if (!elRef.current) return;
    // Clear then set to trigger re-read
    elRef.current.textContent = '';
    requestAnimationFrame(() => {
      if (elRef.current) elRef.current.textContent = message;
    });
  }, []);

  return announce;
}
