import { useRef, useCallback } from 'react';

interface SwipeCallbacks {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

const SWIPE_THRESHOLD = 80; // px

/**
 * Returns touch event handlers for swipe detection.
 * Spread the returned handlers onto the swipeable element.
 */
export function useSwipeHandlers(callbacks: SwipeCallbacks) {
  const startX = useRef(0);
  const deltaX = useRef(0);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    deltaX.current = 0;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    deltaX.current = e.touches[0].clientX - startX.current;
  }, []);

  const onTouchEnd = useCallback(() => {
    if (deltaX.current > SWIPE_THRESHOLD) {
      callbacks.onSwipeRight?.();
    } else if (deltaX.current < -SWIPE_THRESHOLD) {
      callbacks.onSwipeLeft?.();
    }
    deltaX.current = 0;
  }, [callbacks]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
