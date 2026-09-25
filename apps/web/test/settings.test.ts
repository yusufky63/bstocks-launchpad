import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_MAX_BPS,
  SLIPPAGE_MIN_BPS,
  impactLevel,
  isValidSlippageBps,
  parseSlippageInput,
  slippageLevel,
  storeSlippageBps,
} from '@/lib/settings';

describe('trade slippage settings', () => {
  it('defaults to 1% and keeps the 0.1% to 5% bounds', () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(100);
    expect(SLIPPAGE_MIN_BPS).toBe(10);
    expect(SLIPPAGE_MAX_BPS).toBe(500);
  });

  it('turns amber at exactly 3%', () => {
    expect(slippageLevel(299)).toBe('normal');
    expect(slippageLevel(300)).toBe('high');
    expect(slippageLevel(500)).toBe('high');
  });

  it('tiers price impact at exactly 5% and 25%', () => {
    expect(impactLevel(null)).toBe('none');
    expect(impactLevel(Number.NaN)).toBe('none');
    expect(impactLevel(4.99)).toBe('none');
    expect(impactLevel(5)).toBe('warn');
    expect(impactLevel(24.99)).toBe('warn');
    expect(impactLevel(25)).toBe('severe');
  });

  it('parses 0.1% to 5% into basis points', () => {
    expect(parseSlippageInput('0.1')).toEqual({ bps: 10 });
    expect(parseSlippageInput('0.5')).toEqual({ bps: 50 });
    expect(parseSlippageInput('1')).toEqual({ bps: 100 });
    expect(parseSlippageInput('2.75')).toEqual({ bps: 275 });
    expect(parseSlippageInput(' 5 % ')).toEqual({ bps: 500 });
    expect(parseSlippageInput('.5')).toEqual({ bps: 50 });
  });

  it('refuses out-of-range, text and empty input instead of clamping it', () => {
    for (const text of ['0.09', '5.01', '8', '0', '', ' ', 'abc', '1e1', '-1', '1.234', '..5']) {
      expect(parseSlippageInput(text), text).toEqual({ error: 'Enter 0.1% to 5%.' });
    }
  });
});

describe('storing slippage', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal('window', { dispatchEvent: () => true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores valid values exactly and refuses the rest, keeping the last applied value', () => {
    expect(storeSlippageBps(300)).toBe(true);
    expect(store.get('stockpair:slippageBps')).toBe('300');
    // The old setter clamped 800 to 500 and 5 to 10; neither may be stored now.
    expect(storeSlippageBps(800)).toBe(false);
    expect(storeSlippageBps(5)).toBe(false);
    expect(storeSlippageBps(12.5)).toBe(false);
    expect(store.get('stockpair:slippageBps')).toBe('300');
    expect(isValidSlippageBps(10) && isValidSlippageBps(500) && !isValidSlippageBps(501)).toBe(true);
  });
});
