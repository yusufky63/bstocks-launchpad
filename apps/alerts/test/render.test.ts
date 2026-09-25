import { describe, expect, it } from 'vitest';

import {
  a,
  age,
  bar,
  esc,
  fits,
  formatAmount,
  formatShare,
  formatUsd,
  formatUsdCompact,
  launchPost,
  tradePost,
  trim,
  type LaunchDetail,
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
    twitter: 'https://x.com/xBStocks',
    telegram: null,
    poolId: `0x${'ab'.repeat(32)}`,
    ...over,
  };
}

/** A plain launch: no buy and a fixed profile, opening at half what the snapshot's last trade says. */
function launch(over: Partial<LaunchDetail> = {}): LaunchDetail {
  return { openingPriceUsd: 0.0000052, openingFdvUsd: 5_200, creatorBuy: null, metadataEditable: false, ...over };
}

const CREATOR_BUY = { supplyBps: 434, amountStock: 2.11, valueUsd: 474.0959 };

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
      // Every optional line present, so each of them is inside the tag count below.
      launch({ creatorBuy: CREATOR_BUY, metadataEditable: true }),
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

describe('hostile links', () => {
  // A creator's website only has to match /^https?:\/\/\S+$/ to be stored, and a quote is not
  // whitespace. Unescaped it closed the href and opened a second, attacker-chosen link.
  it('escapes the quote that would close an href', () => {
    expect(esc('a"b')).toBe('a&quot;b');
    const out = a('https://evil.test/"><a href="https://phish.test', 'Web');
    expect(out).not.toContain('phish.test');
    expect(out).toBe('Web');
  });

  it('leaves the apostrophe alone, since every attribute here is double-quoted', () => {
    expect(esc("today's")).toBe("today's");
  });

  it('refuses a URL carrying whitespace, brackets or anything below a space', () => {
    for (const bad of ['https://x.test/a b', 'https://x.test/<b>', `https://x.test/${String.fromCodePoint(10)}x`]) {
      expect(a(bad, 'Web')).toBe('Web');
    }
    expect(a(`https://x.test/${'a'.repeat(500)}`, 'Web')).toBe('Web');
  });

  it('still links an ordinary URL', () => {
    expect(a('https://good.test/p?a=1&b=2', 'Web')).toBe('<a href="https://good.test/p?a=1&amp;b=2">Web</a>');
  });
});

describe('trimming', () => {
  // The transport used to slice() to 4096, which cuts through a tag and turns a long post into a
  // 400 and a silent loss.
  it('drops whole lines rather than cutting through a tag', () => {
    const long = { text: ['<b>head</b>', ...Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b>`)].join('\n'), buttons: [] };
    const out = trim(long);
    expect(out.text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(out.text.split('\n').every((l) => !l.includes('<b>') || l.includes('</b>'))).toBe(true);
  });

  it('leaves a post that already fits exactly as it was', () => {
    const post = tradePost(APP, FACTS, snap(), TRADE);
    expect(trim(post)).toEqual(post);
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
    // What was given for what, rather than an arrow the reader has to decode.
    expect(post.text).toContain('2.11 NVDAc for 29.7M STOCK');
    expect(post.text).toContain("This trade is 36% of today's volume");
    expect(post.text).toContain('Buyer');
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
    expect(text).toContain('>DexScreener</a>');
    expect(text).toContain('>Gecko</a>');
    expect(text).toContain('https://x.com/xBStocks');
    expect(text).toContain('dexscreener.com/base/');
    expect(text).toContain('geckoterminal.com/base/pools/');
  });

  // Two chart sites, neither of them promoted over the other by a button.
  it('keeps the buttons to what only this site can do', () => {
    const labels = tradePost(APP, FACTS, snap(), TRADE).buttons.flat().map((btn) => btn.text);
    expect(labels).toEqual(['💱 Trade', '👥 Holders']);
  });

  it('drops a link the creator never gave rather than showing a dead one', () => {
    const text = tradePost(APP, FACTS, snap({ telegram: null, website: null }), TRADE).text;
    expect(text).not.toContain('>TG</a>');
    expect(text).not.toContain('>Web</a>');
    expect(text).toContain('>X</a>');
  });

  it('links Telegram on every kind of card when there is one', () => {
    const withTg = snap({ telegram: 'https://t.me/stockpair' });
    for (const text of [tradePost(APP, FACTS, withTg, TRADE).text, launchPost(APP, FACTS, withTg, launch()).text]) {
      expect(text).toContain('<a href="https://t.me/stockpair">TG</a>');
    }
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

  // A buy that carries a token past a level is one event, not two notifications — and a row that
  // can only produce one post cannot re-send a post that already went out.
  it('says the milestone on the trade card rather than in a second post', () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, milestone: 25_000 });
    expect(post.text).toContain('Carried it past $25K');
    expect(post.text).toContain('BUY');
  });

  it('says a new high the same way', () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, newHighFrom: 9_800 });
    expect(post.text).toContain('New high, beating $9.8K');
  });

  it('turns red for a sell', () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, side: 'sell' });
    expect(post.text.startsWith('🔴')).toBe(true);
    expect(post.text).toContain('SELL');
    // The same two amounts, the other way round, because the trader gave the token this time.
    expect(post.text).toContain('29.7M STOCK for 2.11 NVDAc');
    expect(post.text).toContain('Seller');
  });

  it('keeps every button a URL, since a callback would edit the post for every reader', () => {
    const post = tradePost(APP, FACTS, snap(), TRADE);
    expect(post.buttons.flat().every((btn) => btn.url.startsWith('https://'))).toBe(true);
  });

  it('does not print a share that reads like a rounding artifact', () => {
    const post = tradePost(APP, FACTS, snap(), { ...TRADE, shareOfDay: 1 });
    expect(post.text).toContain("This trade is most of today's volume");
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

describe('a launch post', () => {
  // A token seconds old has no day behind it, no holders outside the pool and no high to have
  // reached. Printing the trade card here gave it a row of dashes and zeros.
  it('says only what is true at zero seconds old', () => {
    const text = launchPost(
      APP,
      FACTS,
      snap({ volume24hUsd: null, change24hPercent: null, holders: 0, topHolders: [], athUsd: null }),
      launch(),
    ).text;
    expect(text).toContain('Opens at');
    expect(text).toContain('trades against');
    expect(text).toContain('1,000,000,000 supply');
    expect(text).not.toContain('24h');
    expect(text).not.toContain('holders');
    expect(text).not.toContain('ATH');
    expect(text).not.toContain('Age');
  });

  // A buy in the launch transaction has moved the last price before this card is sent. Printing
  // that as "opens at" would show everyone else the price after the creator's buy.
  it('opens at the opening price even when the last trade is higher', () => {
    const text = launchPost(APP, FACTS, snap({ priceUsd: 0.0000107, fdvUsd: 10_700 }), launch()).text;
    expect(text).toContain('💰 Opens at $0.00000520 · 💎 FDV $5.2K');
    expect(text).not.toContain('$0.00001070');
    expect(text).not.toContain('$10.7K');
  });

  it('prints a dash rather than a guess when the opening price is unknown', () => {
    const text = launchPost(APP, FACTS, snap(), launch({ openingPriceUsd: null, openingFdvUsd: null })).text;
    expect(text).toContain('💰 Opens at — · 💎 FDV —');
    expect(text).not.toContain('NaN');
  });

  // There is no fee window any more, on new pools or old ones, so there is nothing to warn about.
  it('says nothing about a launch fee schedule', () => {
    const text = launchPost(APP, FACTS, snap(), launch({ creatorBuy: CREATOR_BUY, metadataEditable: true })).text;
    expect(text).not.toContain('99%');
    expect(text).not.toContain('seconds');
    expect(text).not.toContain('Swap fee');
  });

  it('says what the creator bought in the launch transaction', () => {
    const text = launchPost(APP, FACTS, snap(), launch({ creatorBuy: CREATOR_BUY })).text;
    expect(text).toContain('🧑‍💻 Creator bought 4.34% of supply at launch (2.11 NVDAc ≈ $474.10)');
    // Straight after the supply line it qualifies, and before the byline.
    const lines = text.split('\n');
    const bought = lines.findIndex((l) => l.includes('Creator bought'));
    expect(lines[bought - 1]).toContain('1,000,000,000 supply');
    expect(lines[bought + 1]).toContain('👤 by');
  });

  it('leaves out the dollar figure when there is no Chainlink value for it', () => {
    const text = launchPost(APP, FACTS, snap(), launch({ creatorBuy: { ...CREATOR_BUY, valueUsd: null } })).text;
    expect(text).toContain('Creator bought 4.34% of supply at launch (2.11 NVDAc)');
    expect(text).not.toContain('≈');
  });

  it('has no creator line when the creator did not buy', () => {
    expect(launchPost(APP, FACTS, snap(), launch()).text).not.toContain('Creator bought');
  });

  // "All of it in the pool" stops being true the moment a creator buy takes some back out.
  it('does not claim the whole supply is still in the pool', () => {
    const text = launchPost(APP, FACTS, snap(), launch({ creatorBuy: CREATOR_BUY })).text;
    expect(text).toContain('all of it put in the pool');
    expect(text).not.toContain('all of it in the pool');
  });

  it('says when the creator can still change the profile', () => {
    expect(launchPost(APP, FACTS, snap(), launch({ metadataEditable: true })).text).toContain(
      '✏️ Profile editable by the creator',
    );
    expect(launchPost(APP, FACTS, snap(), launch()).text).not.toContain('editable');
  });

  it('still carries the links and the address', () => {
    const text = launchPost(APP, FACTS, snap(), launch()).text;
    expect(text).toContain('>DexScreener</a>');
    expect(text).toContain('>Gecko</a>');
    expect(text).toContain(`<code>${FACTS.token}</code>`);
  });

  it('lets the token page render the preview image', () => {
    expect(launchPost(APP, FACTS, snap(), launch()).preview).toBe(`${APP}/token/${FACTS.token}`);
  });
});

describe('a share of supply', () => {
  it('prints basis points as a percentage without trailing zeros', () => {
    expect(formatShare(434)).toBe('4.34%');
    expect(formatShare(500)).toBe('5%');
    expect(formatShare(1_250)).toBe('12.5%');
    expect(formatShare(10_000)).toBe('100%');
  });

  // A buy under one basis point still bought tokens; "0%" would say it bought none.
  it('does not round a real buy down to nothing', () => {
    expect(formatShare(0)).toBe('<0.01%');
  });

  it('prints a dash for a figure that is not one', () => {
    expect(formatShare(Number.NaN)).toBe('—');
    expect(formatShare(-1)).toBe('—');
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
