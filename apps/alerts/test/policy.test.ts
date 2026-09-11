import { describe, expect, it } from 'vitest';

import { isNewHigh, judgeTrade, nextMilestone, type Market, type TradePayload } from '../src/policy';

const LIMITS = { minTradeUsd: 500, minTradeShare: 0.15, minTradeFloorUsd: 100 };

function market(over: Partial<Market> = {}): Market {
  return {
    token: '0xb2000000000000000000000000000000000000aa',
    name: 'StockPair',
    symbol: 'STOCK',
    poolId: `0x${'ab'.repeat(32)}`,
    stockSymbol: 'NVDAc',
    stockDecimals: 8,
    stockUsd: 224.69,
    priceInStock: 4.9e-8,
    priceUsd: 1.1e-5,
    fdvUsd: 11_000,
    change24hPercent: 1.6,
    volume24hUsd: 3_800,
    holders: 84,
    trades: 2_323,
    ...over,
  };
}

/** `stock` here is NVDAc at 8 decimals, so 1e8 raw is one whole share. */
function trade(stockRaw: string, over: Partial<TradePayload> = {}): TradePayload {
  return {
    side: 'buy',
    amountTokenRaw: (10n ** 24n).toString(),
    amountStockRaw: stockRaw,
    priceTokenInStock: '0.000000049',
    trader: '0x1111111111111111111111111111111111111111',
    txHash: '0xt',
    blockTime: '2026-09-11T00:00:00Z',
    stockDecimals: 8,
    stockUsd8: '22469000000',
    ...over,
  };
}

describe('which trades are worth everyone\'s attention', () => {
  it('posts one that clears the dollar floor', () => {
    // 5 NVDAc at $224.69 = $1,123
    expect(judgeTrade(trade('500000000'), market(), LIMITS)).toMatchObject({ post: true });
  });

  it('keeps quiet about a small one on a busy token', () => {
    // 0.2 NVDAc = $45, and only 1.2% of a $3,800 day
    expect(judgeTrade(trade('20000000'), market({ volume24hUsd: 3_800 }), LIMITS).post).toBe(false);
  });

  // One number cannot serve both ends of the range: an absolute floor alone means a token doing
  // $200 a day is never heard from, and a share alone means the first trade after a quiet night is
  // always "significant".
  it("posts a trade that is most of a quiet token's day", () => {
    // 0.5 NVDAc is $112: over the floor, and more than half of a $200 day.
    const verdict = judgeTrade(trade('50000000'), market({ volume24hUsd: 200 }), LIMITS);
    expect(verdict.post).toBe(true);
    if (verdict.post) expect(verdict.shareOfDay).toBeGreaterThan(0.15);
  });

  // The same $45 trade as the one above it: a large share of a quiet day, but not a sum anyone
  // would call a large trade.
  it('still keeps quiet when a large share is a small amount of money', () => {
    expect(judgeTrade(trade('20000000'), market({ volume24hUsd: 200 }), LIMITS).post).toBe(false);
  });

  // A token doing $5 a day makes a $1 trade 20% of its volume, and "large" has to mean something
  // to a reader rather than only to the arithmetic.
  it("keeps quiet about a tiny trade even when it is the whole of a dead token's day", () => {
    expect(judgeTrade(trade('2000000'), market({ volume24hUsd: 5 }), LIMITS).post).toBe(false);
  });

  it('scales the bar to whichever threshold the trade actually cleared', () => {
    const loud = judgeTrade(trade('500000000'), market(), LIMITS);
    const quiet = judgeTrade(trade('50000000'), market({ volume24hUsd: 200 }), LIMITS);
    expect(loud.post && quiet.post).toBe(true);
    if (loud.post && quiet.post) {
      // Both draw a readable bar rather than one drawing a single emoji and the other a wall.
      expect(Math.floor(loud.valueUsd / loud.stepUsd)).toBeGreaterThanOrEqual(6);
      expect(Math.floor(quiet.valueUsd / quiet.stepUsd)).toBeGreaterThanOrEqual(6);
    }
  });

  // "350% of today's volume" reads as a broken number, not a big trade.
  it('never claims a trade was more than all of the volume it is part of', () => {
    const verdict = judgeTrade(trade('500000000'), market({ volume24hUsd: 100 }), LIMITS);
    expect(verdict.post).toBe(true);
    if (verdict.post) expect(verdict.shareOfDay).toBeLessThanOrEqual(1);
  });

  it('says nothing when it cannot price the trade', () => {
    expect(judgeTrade(trade('500000000', { stockUsd8: null }), market({ stockUsd: null }), LIMITS).post).toBe(false);
    expect(judgeTrade(trade('0'), market(), LIMITS).post).toBe(false);
  });

  // The channel has to say what a trade was worth when it happened, not what the same amount of
  // stock would be worth now.
  it('prices the trade with the quote that was live at the time', () => {
    const cheap = judgeTrade(trade('500000000', { stockUsd8: '10000000000' }), market(), LIMITS);
    expect(cheap.post && Math.round(cheap.valueUsd)).toBe(500);
  });
});

describe('market cap milestones', () => {
  it('reports the highest level newly passed, not every level below it', () => {
    expect(nextMilestone(60_000, 0)).toBe(50_000);
    expect(nextMilestone(60_000, 50_000)).toBeNull();
    expect(nextMilestone(120_000, 50_000)).toBe(100_000);
  });

  it('stays quiet below the first level and on a token it cannot price', () => {
    expect(nextMilestone(9_000, 0)).toBeNull();
    expect(nextMilestone(null, 0)).toBeNull();
  });

  // Falling back under a level and crossing it again is not news.
  it('does not re-announce a level after a dip', () => {
    expect(nextMilestone(26_000, 25_000)).toBeNull();
  });
});

describe('new highs', () => {
  it('needs a gain worth reading about', () => {
    expect(isNewHigh(1.06, 1)).toBe(true);
    expect(isNewHigh(1.01, 1)).toBe(false);
    expect(isNewHigh(null, 1)).toBe(false);
    expect(isNewHigh(1.5, 0)).toBe(false);
  });
});
