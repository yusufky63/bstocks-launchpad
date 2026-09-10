import { describe, expect, it } from 'vitest';

import { bar, esc, fits, formatUsd, formatUsdCompact, launchPost, tradePost } from '../src/render';
import { TEXT_LIMIT } from '../src/telegram';

const APP = 'https://launchpad.basestocks.finance';
const FACTS = { token: '0xb2000000000000000000000000000000000000aa', name: 'StockPair', symbol: 'STOCK', stockSymbol: 'NVDAc' };

describe('escaping', () => {
  // A token name is whatever a creator typed. HTML mode needs three characters escaped, which is a
  // rule that can be held; MarkdownV2 needs eighteen under context-dependent rules, and one miss
  // rejects the whole message with a 400 rather than mangling a word.
  it('neutralises markup in a name a creator chose', () => {
    expect(esc('<b>$FOO_BAR</b>')).toBe('&lt;b&gt;$FOO_BAR&lt;/b&gt;');
    expect(esc('A & B')).toBe('A &amp; B');
  });

  it('carries a hostile name through a whole post without leaving a tag open', () => {
    const post = launchPost(APP, { ...FACTS, name: '<img src=x onerror=alert(1)>', symbol: 'X_Y.Z' }, {
      creator: 'yusuf.base.eth',
      fdvUsd: 10_700,
      poolId: `0x${'ab'.repeat(32)}`,
    });
    expect(post.text).not.toContain('<img');
    expect(post.text).toContain('&lt;img');
    // The only tags left are the ones this module put there.
    expect([...post.text.matchAll(/<[a-z/][^>]*>/gu)].map((m) => m[0])).toEqual(['<b>', '</b>', '<b>', '</b>']);
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
    expect([...bar(10_000, 10, '🟢')]).toHaveLength(48);
  });

  it('never draws nothing', () => {
    expect([...bar(1, 500, '🟢')]).toHaveLength(1);
    expect([...bar(100, 0, '🟢')]).toHaveLength(48);
  });
});

describe('a trade post', () => {
  const detail = {
    side: 'buy' as const,
    valueUsd: 10_000,
    stepUsd: 10,
    amountStock: 44.5,
    amountToken: 931_000_000,
    trader: 'yusuf.base.eth',
    shareOfDay: 0.36,
    fdvUsd: 11_400,
    change24h: 1.6,
    poolId: `0x${'ab'.repeat(32)}`,
  };

  it('stays inside Telegram\'s limit even at the extreme', () => {
    const post = tradePost(APP, FACTS, detail);
    expect(post.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(fits(post)).toBe(true);
  });

  it('says what happened, in the order a reader needs it', () => {
    const post = tradePost(APP, FACTS, detail);
    const lines = post.text.split('\n').filter(Boolean);
    expect(lines[0]).toContain('StockPair');
    expect(lines[0]).toContain('large buy');
    expect(post.text).toContain('$10,000.00');
    expect(post.text).toContain("36% of today's volume");
    expect(post.text).toContain('yusuf.base.eth');
  });

  it('turns red for a sell', () => {
    const post = tradePost(APP, FACTS, { ...detail, side: 'sell' });
    expect(post.text.startsWith('🔴')).toBe(true);
    expect(post.text).toContain('large sell');
  });

  it('offers the chart, the trade page and the holders, all as links', () => {
    const post = tradePost(APP, FACTS, detail);
    const urls = post.buttons.flat().map((b) => b.url);
    expect(urls.some((u) => u.startsWith('https://dexscreener.com/base/'))).toBe(true);
    expect(urls).toContain(`${APP}/token/${FACTS.token}`);
    // Every button is a URL: a callback button in a channel would edit the post for every reader.
    expect(post.buttons.flat().every((b) => typeof b.url === 'string' && b.url.startsWith('https://'))).toBe(true);
  });

  it('drops the volume line rather than printing a share of nothing', () => {
    const post = tradePost(APP, FACTS, { ...detail, shareOfDay: null });
    expect(post.text).not.toContain('of today');
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
