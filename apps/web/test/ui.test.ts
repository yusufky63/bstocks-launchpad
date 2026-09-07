import { describe, expect, it } from 'vitest';

import { bpsToPct, formatCompact, formatPct, formatTokenAmount, formatUsd, shortAddress, timeAgo } from '@/lib/format';
import { isUsMarketOpen, nextSessionBoundary, untilLabel } from '@/lib/market-hours';
import { deadlineIn, describeTradeError, minOutFor, shareOf } from '@/lib/trade';
import { poolReserves, positionAmounts, sqrtRatioAtTick } from '@/lib/liquidity';
import { normalizeTwitter, twitterHandle } from '@/lib/twitter';
import { normalizeTelegram } from '@/lib/profile';
import { applyScreen } from '@/lib/screens';
import type { MarketView } from '@/lib/types';

describe('trade helpers', () => {
  it('applies slippage to the quoted output and never exceeds it', () => {
    expect(minOutFor(1_000_000n, 100)).toBe(990_000n);
    expect(minOutFor(1_000_000n, 50)).toBe(995_000n);
    expect(minOutFor(1_000_000n, 0)).toBe(1_000_000n);
    expect(minOutFor(1_000_000n, 20_000)).toBe(0n);
    expect(minOutFor(7n, 100)).toBe(6n);
  });

  it('builds deadlines in unix seconds', () => {
    expect(deadlineIn(180, 1_700_000_000_500)).toBe(1_700_000_180n);
  });

  it('takes a share of a balance in raw units', () => {
    expect(shareOf(1_000n, 25)).toBe(250n);
    expect(shareOf(1_000n, 100)).toBe(1_000n);
    expect(shareOf(999n, 33)).toBe(329n);
    expect(shareOf(1_000n, 150)).toBe(1_000n);
  });

  it('explains wallet and contract errors in one line', () => {
    expect(describeTradeError(new Error('User rejected the request.\nDetails: …'))).toMatch(/declined/u);
    expect(describeTradeError(new Error('execution reverted: TooLittleReceived()'))).toMatch(/slippage/u);
    expect(describeTradeError(new Error('ERC20: insufficient allowance'))).toMatch(/approve/iu);
    expect(describeTradeError(new Error('Expired()'))).toMatch(/expired/u);
    expect(describeTradeError(new Error('x'.repeat(400)))).toHaveLength(201);
  });
});

describe('format helpers', () => {
  it('formats money, percentages and amounts', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0.00001234)).toBe('$0.00001234');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(2_500_000, { compact: true })).toBe('$2.5M');
    expect(formatUsd(null)).toBe('—');
    expect(formatPct(3.456)).toBe('+3.46%');
    expect(formatPct(-1, { digits: 1 })).toBe('-1.0%');
    expect(bpsToPct(100)).toBe('1%');
    expect(bpsToPct(50)).toBe('0.5%');
    expect(bpsToPct(9_900)).toBe('99%');
    expect(formatCompact(12_345)).toBe('12.3K');
    expect(formatTokenAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatTokenAmount('123456789', 8)).toBe('1.2346');
    expect(shortAddress('0x78de409a6306550882328E2a67160471368387FF')).toBe('0x78de…87FF');
  });

  it('describes relative time', () => {
    expect(timeAgo(Date.now() - 2_000)).toBe('just now');
    expect(timeAgo(Date.now() - 90_000)).toBe('1m ago');
    expect(timeAgo(Date.now() - 3 * 86_400_000)).toBe('3d ago');
  });
});

describe('market hours', () => {
  it('knows the NYSE regular session in New York time', () => {
    expect(isUsMarketOpen(new Date('2026-09-04T15:00:00Z'))).toBe(true); // Friday 11:00 ET
    expect(isUsMarketOpen(new Date('2026-09-04T20:30:00Z'))).toBe(false); // Friday 16:30 ET
    expect(isUsMarketOpen(new Date('2026-09-05T15:00:00Z'))).toBe(false); // Saturday
  });

  it('walks to the next boundary and labels the wait', () => {
    const saturday = new Date('2026-09-05T21:00:00Z');
    const next = nextSessionBoundary(saturday);
    expect(next.open).toBe(false);
    expect(next.at.toISOString()).toBe('2026-09-07T13:30:00.000Z'); // Monday 09:30 ET
    expect(untilLabel(next.at.getTime() - saturday.getTime())).toBe('1d 16h');
    expect(untilLabel(25 * 60_000)).toBe('25m');
  });
});

describe('pool reserves from the locked position', () => {
  const Q96 = 2 ** 96;
  it('splits a position into both currencies at the current price', () => {
    // Range [-1000, 1000], price at tick 0 (sqrtP = 1): symmetric amounts.
    const { amount0, amount1 } = positionAmounts({ sqrtPriceX96: BigInt(Math.round(Q96)), tickLower: -1_000, tickUpper: 1_000, liquidity: 1_000_000n });
    expect(amount0).toBeCloseTo(amount1, 0);
    expect(amount0).toBeGreaterThan(0);
    expect(sqrtRatioAtTick(0)).toBe(1);
  });

  it('is single-sided outside the range', () => {
    const below = positionAmounts({ sqrtPriceX96: BigInt(Math.round(sqrtRatioAtTick(-5_000) * Q96)), tickLower: -1_000, tickUpper: 1_000, liquidity: 1_000_000n });
    expect(below.amount1).toBe(0);
    expect(below.amount0).toBeGreaterThan(0);
    const above = positionAmounts({ sqrtPriceX96: BigInt(Math.round(sqrtRatioAtTick(5_000) * Q96)), tickLower: -1_000, tickUpper: 1_000, liquidity: 1_000_000n });
    expect(above.amount0).toBe(0);
  });

  it('orients reserves by which side the token is on', () => {
    const input = { sqrtPriceX96: BigInt(Math.round(Q96)), tickLower: -1_000, tickUpper: 1_000, liquidity: 10n ** 24n, stockDecimals: 8 };
    const asZero = poolReserves({ ...input, tokenIsCurrency0: true });
    const asOne = poolReserves({ ...input, tokenIsCurrency0: false });
    expect(asZero.token / asOne.token).toBeCloseTo(1, 9);
    expect(asZero.stock / asOne.stock).toBeCloseTo(1, 9);
    expect(asZero.tokenShareOfSupply).toBeGreaterThan(0);
    expect(asZero.tokenShareOfSupply).toBeLessThanOrEqual(1);
  });
});

describe('X handles', () => {
  it('normalises handles and URLs, rejects everything else', () => {
    expect(normalizeTwitter('@stockpair')).toBe('https://x.com/stockpair');
    expect(normalizeTwitter(' StockPair ')).toBe('https://x.com/StockPair');
    expect(normalizeTwitter('https://twitter.com/stockpair/')).toBe('https://x.com/stockpair');
    expect(normalizeTwitter('x.com/stockpair')).toBe('https://x.com/stockpair');
    expect(normalizeTwitter('https://x.com/stockpair?ref=1')).toBeNull();
    expect(normalizeTelegram('t.me/stockpair')).toBe('https://t.me/stockpair');
    expect(normalizeTelegram('@stockpair')).toBe('https://t.me/stockpair');
    expect(normalizeTelegram('https://t.me/+AbCdEf123')).toBe('https://t.me/+AbCdEf123');
    expect(normalizeTelegram('abc')).toBeNull();
    expect(normalizeTwitter('javascript:alert(1)')).toBeNull();
    expect(normalizeTwitter('')).toBeNull();
    expect(twitterHandle('https://x.com/stockpair')).toBe('@stockpair');
  });
});

describe('markets board ordering', () => {
  // Only the fields the screener reads matter here; the rest of a MarketView is irrelevant to it.
  const row = (over: Partial<MarketView>): MarketView =>
    ({
      symbol: 'S',
      launchedAt: '2026-09-01T00:00:00.000Z',
      volume24hUsd: null,
      trades24h: 0,
      holders: 0,
      change24hPercent: 0,
      ...over,
    }) as unknown as MarketView;

  it('leads the default board with what is being traded, not what launched last', () => {
    const quiet = row({ token: '0xquiet', symbol: 'QUIET', launchedAt: '2026-09-09T00:00:00.000Z', volume24hUsd: 0, holders: 1 });
    const busy = row({ token: '0xbusy', symbol: 'BUSY', launchedAt: '2026-09-02T00:00:00.000Z', volume24hUsd: 340_000, trades24h: 2_000, holders: 160 });
    const small = row({ token: '0xsmall', symbol: 'SMALL', launchedAt: '2026-09-03T00:00:00.000Z', volume24hUsd: 25_000, trades24h: 40, holders: 14 });

    expect(applyScreen([quiet, busy, small], 'all').map((m) => m.symbol)).toEqual(['BUSY', 'SMALL', 'QUIET']);
  });

  it('breaks ties on trades, then holders, so an untraded launch never outranks a used one', () => {
    const a = row({ token: '0xa', symbol: 'A', volume24hUsd: 0, trades24h: 0, holders: 1 });
    const b = row({ token: '0xb', symbol: 'B', volume24hUsd: 0, trades24h: 0, holders: 40 });
    expect(applyScreen([a, b], 'all').map((m) => m.symbol)).toEqual(['B', 'A']);
  });

  it('leaves the New screen ordered by recency', () => {
    const older = row({ token: '0x1', symbol: 'OLDER', launchedAt: new Date(Date.now() - 3_600_000).toISOString(), volume24hUsd: 900_000 });
    const newer = row({ token: '0x2', symbol: 'NEWER', launchedAt: new Date(Date.now() - 60_000).toISOString(), volume24hUsd: 0 });
    // 'new' filters rather than sorts, so the caller's order (newest first from the API) survives.
    expect(applyScreen([newer, older], 'new').map((m) => m.symbol)).toEqual(['NEWER', 'OLDER']);
  });
});
