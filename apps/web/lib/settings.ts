'use client';

import { useCallback, useSyncExternalStore } from 'react';

export const DEFAULT_SLIPPAGE_BPS = 100;
const KEY = 'stockpair:slippageBps';
const EVENT = 'stockpair:settings';

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isInteger(v) && v >= 10 && v <= 500) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SLIPPAGE_BPS;
}

function subscribe(cb: () => void) {
  window.addEventListener('storage', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(EVENT, cb);
  };
}

/** User-adjustable slippage (bps), persisted locally, bounded to sane limits. */
export function useSlippage() {
  const slippageBps = useSyncExternalStore(subscribe, read, () => DEFAULT_SLIPPAGE_BPS);
  const setSlippageBps = useCallback((v: number) => {
    const clamped = Math.min(500, Math.max(10, Math.round(v)));
    try {
      localStorage.setItem(KEY, String(clamped));
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { slippageBps, setSlippageBps };
}

/** SSR-safe media query (server snapshot = false). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
