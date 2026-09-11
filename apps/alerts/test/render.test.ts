import { describe, expect, it } from 'vitest';

import {
  age,
  bar,
  esc,
  fits,
  formatAmount,
  formatUsd,
  formatUsdCompact,
  launchPost,
  tradePost,
  type Snapshot,
  type TokenFacts,
} from '../src/render';
import { TEXT_LIMIT } from '../src/telegram';

const APP = 'https://launchpad.basestocks.finance';

const FACTS: TokenFacts = {
  token: '0xb2000000000000000000000000000000000000aa',
  name: 'StockPair',
  symbol: 'STOCK',
  stockSymbol: 'NVDAc',
  stockAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
};

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    priceUsd: 0.0000107,
    fdvUsd: 10_700,
    athUsd: 11_400,
    volume24hUsd: 3_800,
    change24hPercent: 1.6,
    buys24h: 17,
    sells24h: 19,
    holders: 84,
    topHolders: [
      { address: '0x1111111111111111111111111111111111111111', sharePercent: 4.1 },
      { address: '0x2222222222222222222222222222222222222222', sharePercent: 2.8 },
    ],
    topShare: 23,
    launchedAt: '2026-09-06T01:54:01.000Z',
    creator: '0x3333333333333333333333333333333333333333',
    creatorName: 'yusuf.base.eth',
    website: 'https://basestocks.finance',
    twitter: 'https://x.com/xBaseStocks',
    telegram: null,
    poolId: `0x${'ab'.repeat(32)}`,
    ...over,
  };
}

const TRADE = {
  side: 'buy' as const,
  valueUsd: 474.91,
  stepUsd: 83,
  amountStock: 2.11,
  amountToken: 29_700_000,
  trader: '0x7f7c000000000000000000000000000000009aaa',
  traderName: '0x7f7c…9aaa',
  shareOfDay: 0.36,
  txHash: `0x${'cd'.repeat(32)}`,
};

describe('escaping', () => {
  // A token name is whatever a creator typed. HTML mode needs three characters escaped, which is a
  // rule that can be held; MarkdownV2 needs eighteen under context-dependent rules, and one miss
  // rejects the whole message with a 400 rather than mangling a word.
  it('neutralises markup in a name a creator chose', () => {
    expect(esc('<b>$FOO_BAR</b>')).toBe('&lt;b&gt;$FOO_BAR&lt;/b&gt;');
    expect(esc('A & B')).toBe('A &amp; B');
  });

  it('carries a hostile name and a hostile link through without leaving a tag open', () => {
    const post = launchPost(
      APP,
      { ...FACTS, name: '<img src=x onerror=alert(1)>', symbol: 'X_Y.Z' },
      snap({ website: 'javascript:alert(1)', twitter: 'tg://resolve?domain=evil' }),
    );
    expect(post.text).not.toContain('<img');
    expect(post.text).toContain('&lt;img');
    // A creator-supplied href that is not http(s) renders as plain text, never as a link.
    expect(post.text).not.toContain('javascript:');
    expect(post.text).not.toContain('tg://');
    // Every tag left is one this module opened and closed itself.
    const tags = [...post.text.matchAll(/<(\/?)([a-z]+)/gu)].map((m) => `${m[1]}${m[2]}`);
    expect(tags.filter((t) => t.startsWith('/')).length).toBe(tags.filter((t) => !t.startsWith('/')).length);
  });
});

describe('the bar', () => {
  it('grows with the trade', () => {
    expect(bar(100, 100, '🟢')).toBe('🟢');
    expect([...bar(600, 100, '🟢')]).toHaveLength(6);
  });

  // The one open-source buy bot with real code uses one emoji per $10 with no ceiling, which draws
  // a thousand of them for a $10,000 buy against a 4,096 character limit.
  it('stops before it becomes a wall', () => {
    expect([...bar(10_000, 10, '🟢')]).toHaveLength(20);
  });

  it('never draws nothing', () => {
    expect([...bar(1, 500, '🟢')]).toHaveLength(1);
    expect([...bar(100, 0, '🟢')]).toHaveLength(20);
  });
});

describe('a trade post', () => {
  it("stays inside Telegram's limit even at the extreme", () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, valueUsd: 10_000, stepUsd: 10 });
    expect(post.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(fits(post)).toBe(true);
  });

  it('leads with the trade and follows with the token', () => {
    const post = tradePost(APP, FACTS, snap(), TRADE);
    expect(post.text.split('\n')[0]).toContain('StockPair');
    expect(post.text).toContain('BUY');
    expect(post.text).toContain('$474.91');
    expect(post.text).toContain('2.11 NVDAc');
    expect(post.text).toContain("36% of today's volume");
  });

  it('carries the numbers a reader would otherwise go and look up', () => {
    const text = tradePost(APP, FACTS, snap(), TRADE).text;
    expect(text).toContain('FDV $10.7K');
    expect(text).toContain('ATH $11.4K');
    expect(text).toContain('24h +1.6%');
    expect(text).toContain('🅑 17');
    expect(text).toContain('🅢 19');
    expect(text).toContain('84 holders');
    expect(text).toMatch(/Age \d+d/u);
  });

  it('makes every wallet and the transaction tappable', () => {
    const text = tradePost(APP, FACTS, snap(), TRADE).text;
    expect(text).toContain(`href="https://basescan.org/address/${TRADE.trader}"`);
    expect(text).toContain(`href="https://basescan.org/tx/${TRADE.txHash}"`);
    // Each top holder is a link on its own percentage.
    expect(text).toContain('href="https://basescan.org/address/0x1111111111111111111111111111111111111111"');
    expect(text).toContain('4.1');
  });

  // A 🌍 next to a 🐦 is two smudges, and one emoji is a smaller tap target than a fingertip.
  it('labels its links with words rather than icons', () => {
    const text = tradePost(APP, FACTS, snap(), TRADE).text;
    expect(text).toContain('>Web</a>');
    expect(text).toContain('>X</a>');
    expect(text).toContain('>Chart</a>');
    expect(text).toContain('https://x.com/xBaseStocks');
    expect(text).toContain('dexscreener.com/base/');
  });

  it('drops a link the creator never gave rather than showing a dead one', () => {
    const text = tradePost(APP, FACTS, snap({ telegram: null, website: null }), TRADE).text;
    expect(text).not.toContain('>TG</a>');
    expect(text).not.toContain('>Web</a>');
    expect(text).toContain('>X</a>');
  });

  // True of every token this launchpad makes, so it says nothing about this one.
  it('does not repeat what is true of every token', () => {
    const text = tradePost(APP, FACTS, snap(), TRADE).text;
    expect(text).not.toContain('No admin');
    expect(text).not.toContain('Supply in pool');
  });

  it('puts the address in a code block, which is tap-to-copy', () => {
    expect(tradePost(APP, FACTS, snap(), TRADE).text).toContain(`<code>${FACTS.token}</code>`);
  });

  it('turns red for a sell', () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, side: 'sell' });
    expect(post.text.startsWith('🔴')).toBe(true);
    expect(post.text).toContain('SELL');
  });

  it('keeps every button a URL, since a callback would edit the post for every reader', () => {
    const post = tradePost(APP, FACTS, snap(), TRADE);
    expect(post.buttons.flat().every((btn) => btn.url.startsWith('https://'))).toBe(true);
  });

  it('does not print a share that reads like a rounding artifact', () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, shareOfDay: 1 });
    expect(post.text).toContain("most of today's volume");
    expect(post.text).not.toContain('100%');
  });

  it('drops the volume line rather than printing a share of nothing', () => {
    expect(tradePost(APP, FACTS, snap(), { ...TRADE, shareOfDay: null }).text).not.toContain('of today');
  });

  it('says nothing rather than guessing when a figure is missing', () => {
    const text = tradePost(
      APP,
      FACTS,
      snap({ priceUsd: null, fdvUsd: null, athUsd: null, change24hPercent: null, volume24hUsd: null }),
      TRADE,
    ).text;
    expect(text).toContain('—');
    expect(text).not.toContain('NaN');
  });
});

describe('amounts', () => {
  // Token amounts run to hundreds of millions and stock amounts to a couple of units.
  it('keeps the digits that matter at both ends of the range', () => {
    expect(formatAmount(931_000_000)).toBe('931M');
    expect(formatAmount(2.11)).toBe('2.11');
    expect(formatAmount(2)).toBe('2');
    expect(formatAmount(0.0055)).toBe('0.0055');
    expect(formatAmount(null)).toBe('—');
  });
});

describe('money', () => {
  it('keeps enough digits for a token that costs a fraction of a cent', () => {
    expect(formatUsd(0.0000107)).toBe('$0.00001070');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(null)).toBe('—');
  });

  it('compacts only where it does not lose the point', () => {
    expect(formatUsdCompact(11_400)).toBe('$11.4K');
    expect(formatUsdCompact(352_000)).toBe('$352K');
    expect(formatUsdCompact(120)).toBe('$120.00');
  });
});

describe('age', () => {
  const now = new Date('2026-09-11T00:00:00Z');
  it('uses the coarsest unit that still says something', () => {
    expect(age('2026-09-10T23:30:00Z', now)).toBe('30m');
    expect(age('2026-09-10T18:00:00Z', now)).toBe('6h');
    expect(age('2026-09-06T00:00:00Z', now)).toBe('5d');
    expect(age('2026-06-11T00:00:00Z', now)).toBe('3mo');
  });
});
