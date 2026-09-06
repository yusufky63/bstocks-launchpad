import { describe, expect, it } from 'vitest';

import {
  e30ToDecimalString,
  e30ToNumber,
  fdvUsd,
  feeBpsAt,
  formatAmount,
  parseAmount,
  percentChange,
  stockPerTokenE30,
  tokenUsd,
} from '../src/math';

const Q96 = 1n << 96n;

/** sqrtPriceX96 for a raw price p = raw1/raw0 given as a fraction num/den. */
function sqrtPriceFor(num: bigint, den: bigint): bigint {
  // sqrt(num/den) * 2^96, computed with 60 extra bits of precision
  const scaled = (num << 120n) / den;
  let x = scaled;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + scaled / x) / 2n;
  }
  return (x * Q96) >> 60n;
}

describe('stockPerTokenE30', () => {
  it('handles the token as currency0 (price = stock per token)', () => {
    // 1 raw stock per 1e10 raw token -> 1 whole stock (1e8) per 1e18 raw token -> 1 stock per token
    const sqrt = sqrtPriceFor(1n, 10n ** 10n);
    const price = stockPerTokenE30(sqrt, true, 8);
    expect(e30ToNumber(price)).toBeCloseTo(1, 6);
  });

  it('handles the token as currency1 (price = token per stock)', () => {
    // 1e10 raw token per 1 raw stock -> 1e18 raw token per 1e8 raw stock -> 1 token per stock
    const sqrt = sqrtPriceFor(10n ** 10n, 1n);
    const price = stockPerTokenE30(sqrt, false, 8);
    expect(e30ToNumber(price)).toBeCloseTo(1, 6);
  });

  it('matches the launch valuation: 5,000 USD FDV at NVDA 229.9573 USD', () => {
    // whole tokens per whole stock W = 229.9573 * 1e9 / 5000 = 45,991,460
    const stockUsd8 = 22_995_730_000n;
    const tokensPerStock = (stockUsd8 * 10n ** 9n) / 5_000_00000000n;
    // token as currency1: raw token per raw stock = W * 1e18 / 1e8
    const sqrt = sqrtPriceFor(tokensPerStock * 10n ** 18n, 10n ** 8n);
    const price = stockPerTokenE30(sqrt, false, 8);
    expect(fdvUsd(price, stockUsd8)).toBeCloseTo(5_000, 0);
    expect(tokenUsd(price, stockUsd8)).toBeCloseTo(0.000005, 9);
  });

  it('serialises to a 30-decimal string', () => {
    expect(e30ToDecimalString(1_500_000_000_000_000_000_000_000_000_000n)).toBe(
      '1.500000000000000000000000000000',
    );
    expect(e30ToDecimalString(1n)).toBe('0.000000000000000000000000000001');
  });
});

describe('feeBpsAt', () => {
  it('decays from 99% to 1% over twenty seconds', () => {
    expect(feeBpsAt(100, 100)).toBe(9_900);
    expect(feeBpsAt(100, 110)).toBe(5_000);
    expect(feeBpsAt(100, 120)).toBe(100);
    expect(feeBpsAt(100, 10_000)).toBe(100);
  });
});

describe('amounts', () => {
  it('formats raw amounts', () => {
    expect(formatAmount(123_456_789_000_000_000_000n, 18, 4)).toBe('123.4567');
    expect(formatAmount(100_000_000n, 8)).toBe('1');
    expect(formatAmount(-250_000_000n, 8, 2)).toBe('-2.5');
    expect(formatAmount(1_234_567n * 10n ** 18n, 18)).toBe('1,234,567');
  });

  it('parses user input', () => {
    expect(parseAmount('1.5', 8)).toBe(150_000_000n);
    expect(parseAmount('1,000', 18)).toBe(1_000n * 10n ** 18n);
    expect(parseAmount('0.123456789', 8)).toBeNull();
    expect(parseAmount('abc', 8)).toBeNull();
    expect(parseAmount('', 8)).toBeNull();
  });

  it('computes percent change', () => {
    expect(percentChange(100, 150)).toBe(50);
    expect(percentChange(0, 1)).toBeNull();
  });
});
