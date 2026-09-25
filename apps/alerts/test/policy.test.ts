import { describe, expect, it } from 'vitest';

import {
  isLaunchBuy,
  isNewHigh,
  judgeTrade,
  nextMilestone,
  toLaunch,
  toLinks,
  type LaunchRowFacts,
  type LinkRowFacts,
  type Market,
  type TradePayload,
} from '../src/policy';

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
      expect(Math.floor(loud.valueUsd / loud.stepUsd)).toBeGreaterThanOrEqual(3);
      expect(Math.floor(quiet.valueUsd / quiet.stepUsd)).toBeGreaterThanOrEqual(3);
    }
  });

  // Ten real trades between $108 and $475 all drew a full twenty, because the step came from the
  // percentage alone and a $167 day makes that $25.
  it('draws different bars for trades that are different sizes', () => {
    const day = market({ volume24hUsd: 167 });
    const lengths = ['50000000', '100000000', '211000000'].map((raw) => {
      const v = judgeTrade(trade(raw), day, LIMITS);
      return v.post ? Math.min(20, Math.max(1, Math.floor(v.valueUsd / v.stepUsd))) : 0;
    });
    expect(new Set(lengths).size).toBe(lengths.length);
    expect(lengths[0]).toBeLessThan(lengths[2]!);
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

/**
 * Opens at 1e-8 NVDAc per token either way round: 2^96 / 1e9 is a raw price of 1e-18 stock per
 * token with the token as currency0, and 2^96 · 1e9 is 1e18 tokens per stock with it as currency1.
 * At $224.69 that is $0.0000022469 a token and an FDV of $2,246.90.
 */
const SQRT_TOKEN0 = ((1n << 96n) / 1_000_000_000n).toString();
const SQRT_TOKEN1 = ((1n << 96n) * 1_000_000_000n).toString();
const OPENING_USD = 0.0000022469;

function launchRow(over: Partial<LaunchRowFacts> = {}): LaunchRowFacts {
  return {
    opening_sqrt_price_x96: SQRT_TOKEN0,
    token_is_currency0: true,
    stock_decimals: 8,
    stock_usd8_at_launch: '22469000000',
    metadata_editable: false,
    metadata_locked_at: null,
    ...over,
  };
}

/** 2.11 NVDAc in, 4.34% of the billion out: the shape the indexer queues from CreatorBought. */
const BUY = {
  stockInRaw: '211000000',
  feeRaw: '2110000',
  tokensOutRaw: (434n * 10n ** 23n).toString(),
  supplyBps: 434,
};

describe('what a launch card says about the launch', () => {
  // The market row is read at send time, and a buy in the launch transaction has already moved
  // its last price by then.
  it("takes the opening price from what the indexer queued, and the FDV from that", () => {
    const launch = toLaunch(launchRow(), { openingPriceUsd: 0.0000052, creatorBuy: null, metadataEditable: false });
    expect(launch.openingPriceUsd).toBe(0.0000052);
    expect(launch.openingFdvUsd).toBeCloseTo(5_200, 6);
  });

  // A row queued before the indexer sent these fields is still in the outbox after a deploy.
  it('works the opening price out from the launch row for a payload queued before it was sent', () => {
    for (const row of [launchRow(), launchRow({ opening_sqrt_price_x96: SQRT_TOKEN1, token_is_currency0: false })]) {
      const launch = toLaunch(row, { name: 'StockPair', symbol: 'STOCK', stockUsd8: '22469000000' });
      expect(launch.openingPriceUsd! / OPENING_USD).toBeCloseTo(1, 9);
      expect(launch.openingFdvUsd! / (OPENING_USD * 1e9)).toBeCloseTo(1, 9);
      expect(launch.creatorBuy).toBeNull();
      expect(launch.metadataEditable).toBe(false);
    }
  });

  it('survives a payload that is not an object at all', () => {
    for (const payload of [null, undefined, 'launch', 7, []]) {
      const launch = toLaunch(launchRow(), payload);
      expect(launch.openingPriceUsd! / OPENING_USD).toBeCloseTo(1, 9);
      expect(launch.creatorBuy).toBeNull();
    }
  });

  it('falls back to the row when the queued price is not a price', () => {
    for (const openingPriceUsd of [0, -1, Number.NaN, '0.0000052', null]) {
      expect(toLaunch(launchRow(), { openingPriceUsd }).openingPriceUsd! / OPENING_USD).toBeCloseTo(1, 9);
    }
  });

  it('says nothing about a price it cannot work out', () => {
    const launch = toLaunch(launchRow({ stock_usd8_at_launch: '0', opening_sqrt_price_x96: 'x' }), {});
    expect(launch.openingPriceUsd).toBeNull();
    expect(launch.openingFdvUsd).toBeNull();
  });

  // Priced with the Chainlink value the factory read at launch, not today's quote.
  it("prices the creator's buy at the stock's value at launch", () => {
    const launch = toLaunch(launchRow(), { creatorBuy: BUY });
    expect(launch.creatorBuy).not.toBeNull();
    expect(launch.creatorBuy!.supplyBps).toBe(434);
    expect(launch.creatorBuy!.amountStock).toBeCloseTo(2.11, 12);
    expect(launch.creatorBuy!.valueUsd).toBeCloseTo(2.11 * 224.69, 9);
  });

  it('reads a stock of any precision', () => {
    const launch = toLaunch(launchRow({ stock_decimals: 18 }), { creatorBuy: { ...BUY, stockInRaw: '2110000000000000000' } });
    expect(launch.creatorBuy!.amountStock).toBeCloseTo(2.11, 12);
  });

  it('leaves the dollar figure out rather than print one with no stock price behind it', () => {
    expect(toLaunch(launchRow({ stock_usd8_at_launch: '0' }), { creatorBuy: BUY }).creatorBuy!.valueUsd).toBeNull();
  });

  // The indexer's figure keeps this card and the token page's "Dev buy" in agreement.
  it("uses the indexer's share, and the same floor when it did not send one", () => {
    expect(toLaunch(launchRow(), { creatorBuy: { ...BUY, supplyBps: '434' } }).creatorBuy!.supplyBps).toBe(434);
    const tokensOutRaw = (4_349n * 10n ** 22n).toString(); // 4.349%
    for (const supplyBps of [undefined, 'lots', 20_000, -1]) {
      expect(toLaunch(launchRow(), { creatorBuy: { ...BUY, tokensOutRaw, supplyBps } }).creatorBuy!.supplyBps).toBe(434);
    }
  });

  it('shows no buy rather than a wrong one when the queued buy does not parse', () => {
    for (const creatorBuy of [
      { ...BUY, stockInRaw: 'abc' },
      { ...BUY, stockInRaw: '-5' },
      { ...BUY, tokensOutRaw: '0' },
      { ...BUY, tokensOutRaw: undefined },
      'bought',
      null,
    ]) {
      expect(toLaunch(launchRow(), { creatorBuy }).creatorBuy).toBeNull();
    }
  });

  it('says the profile is editable when the creator chose it', () => {
    expect(toLaunch(launchRow(), { metadataEditable: true }).metadataEditable).toBe(true);
    expect(toLaunch(launchRow(), { metadataEditable: false }).metadataEditable).toBe(false);
    // Nothing queued: the launch row is the record of the choice.
    expect(toLaunch(launchRow({ metadata_editable: true }), {}).metadataEditable).toBe(true);
  });

  // A backlog can hold a card long enough for the creator to lock the profile before it goes out.
  it('does not call a profile editable once it has been locked', () => {
    const locked = launchRow({ metadata_editable: true, metadata_locked_at: new Date('2026-09-25T00:00:00Z') });
    expect(toLaunch(locked, { metadataEditable: true }).metadataEditable).toBe(false);
  });
});

/** A token with no signed profile: whatever its launch JSON said, and nothing else. */
function linkRow(over: Partial<LinkRowFacts> = {}): LinkRowFacts {
  return {
    metadata_editable: false,
    website: 'https://stockpair.test',
    twitter: 'https://x.com/stockpair',
    telegram: 'https://t.me/stockpair',
    profile_website: null,
    profile_twitter: null,
    profile_telegram: null,
    ...over,
  };
}

describe("where a card's links point", () => {
  // The Telegram link from the launch JSON used to be dropped while Web and X fell back to it.
  it('falls back to the launch row for Telegram, as it does for the website and X', () => {
    expect(toLinks(linkRow())).toEqual({
      website: 'https://stockpair.test',
      twitter: 'https://x.com/stockpair',
      telegram: 'https://t.me/stockpair',
    });
  });

  it('lets a signed profile override the launch row field by field', () => {
    const links = toLinks(linkRow({ profile_telegram: 'https://t.me/signed', profile_website: 'https://signed.test' }));
    expect(links).toEqual({ website: 'https://signed.test', twitter: 'https://x.com/stockpair', telegram: 'https://t.me/signed' });
  });

  // Its onchain updates land on the launch row, and a signed profile never applies to it.
  it('reads only the launch row for a token with an editable profile', () => {
    const links = toLinks(
      linkRow({
        metadata_editable: true,
        telegram: 'https://t.me/onchain',
        profile_website: 'https://signed.test',
        profile_twitter: 'https://x.com/signed',
        profile_telegram: 'https://t.me/signed',
      }),
    );
    expect(links).toEqual({ website: 'https://stockpair.test', twitter: 'https://x.com/stockpair', telegram: 'https://t.me/onchain' });
  });

  // Tokens from before a launch row carried Telegram keep the links they had, and show no dead one.
  it('keeps what an older token had and leaves out what it never gave', () => {
    const old = { ...linkRow({ website: null, twitter: null, profile_twitter: 'https://x.com/old' }), telegram: undefined } as unknown as LinkRowFacts;
    expect(toLinks(old)).toEqual({ website: null, twitter: 'https://x.com/old', telegram: null });
    expect(toLinks(linkRow({ telegram: null, profile_telegram: 'https://t.me/old' })).telegram).toBe('https://t.me/old');
  });
});

describe("the creator's buy at launch", () => {
  // Already a line on the launch card; a trade post as well would announce the same buy twice.
  it('is not a trade post of its own', () => {
    expect(isLaunchBuy(trade('500000000', { launchBuy: true }))).toBe(true);
  });

  it('leaves every other trade alone, including ones queued before the flag existed', () => {
    expect(isLaunchBuy(trade('500000000', { launchBuy: false }))).toBe(false);
    expect(isLaunchBuy(trade('500000000'))).toBe(false);
  });
});
