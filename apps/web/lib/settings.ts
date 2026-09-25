'use client';

import { useCallback, useSyncExternalStore } from 'react';

export const DEFAULT_SLIPPAGE_BPS = 100;
/** Trade slippage bounds: 0.1% to 5%. The cap is a safeguard, so a value outside it is refused, never clamped. */
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 500;
/** Amber from here: the review sheet spells out how little the trade may return. */
export const SLIPPAGE_HIGH_BPS = 300;
/** Price impact tiers, in percent: amber from 5, red with a required tick from 25. */
export const IMPACT_WARN_PCT = 5;
export const IMPACT_SEVERE_PCT = 25;

const KEY = 'stockpair:slippageBps';
const EVENT = 'stockpair:settings';

export function isValidSlippageBps(v: number): boolean {
  return Number.isInteger(v) && v >= SLIPPAGE_MIN_BPS && v <= SLIPPAGE_MAX_BPS;
}

/**
 * A typed percentage as basis points, or the one error to show. Out-of-range input is an error, not
 * a quiet clamp to the nearest bound: someone who typed 8% must see that 8% is not what applies.
 */
export function parseSlippageInput(text: string): { bps: number } | { error: string } {
  const error = { error: 'Enter 0.1% to 5%.' };
  const trimmed = text.trim().replace(/%$/u, '').trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/u.test(trimmed)) return error;
  const bps = Math.round(Number(trimmed) * 100);
  return isValidSlippageBps(bps) ? { bps } : error;
}

export function slippageLevel(bps: number): 'normal' | 'high' {
  return bps >= SLIPPAGE_HIGH_BPS ? 'high' : 'normal';
}

export function impactLevel(pct: number | null | undefined): 'none' | 'warn' | 'severe' {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'none';
  if (pct >= IMPACT_SEVERE_PCT) return 'severe';
  return pct >= IMPACT_WARN_PCT ? 'warn' : 'none';
}

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (isValidSlippageBps(v)) return v;
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

/**
 * Stores a slippage value if it is valid and reports whether it did. Anything outside the bounds is
 * refused as it is; the previous value stays applied.
 */
export function storeSlippageBps(v: number): boolean {
  if (!isValidSlippageBps(v)) return false;
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
  return true;
}

/** User-adjustable slippage (bps), persisted locally. Only valid values are ever stored. */
export function useSlippage() {
  const slippageBps = useSyncExternalStore(subscribe, read, () => DEFAULT_SLIPPAGE_BPS);
  const setSlippageBps = useCallback((v: number) => storeSlippageBps(v), []);
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
