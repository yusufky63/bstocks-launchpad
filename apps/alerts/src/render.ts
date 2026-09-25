import { TEXT_LIMIT, type InlineButton } from './telegram';

/**
 * Telegram's HTML mode, not MarkdownV2.
 *
 * MarkdownV2 asks for eighteen characters to be escaped under rules that change with context, and
 * a single miss does not mangle a word — it rejects the whole message with a 400. Token names come
 * from whatever a creator typed and routinely carry `_`, `.` and `$`. HTML asks for three
 * characters, context-free, which is a rule that can actually be held.
 */
export function esc(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    // Telegram's own escaping rule names only the three above, because it is written for message
    // *text*. This function also fills href attributes, and a quote there closes the attribute:
    // a creator's website of `https://x.test/"><a href="https://phish.test` passed the site's own
    // URL check (a quote is not whitespace) and rendered as a second, attacker-chosen link.
    // Every attribute this module writes is double-quoted, so the quote is the one that can close
    // one early. A single quote inside it is inert, and escaping it would put &#39; through the
    // middle of ordinary prose for no gain.
    .replace(/"/gu, '&quot;');
}

export function b(value: string): string {
  return `<b>${esc(value)}</b>`;
}

export function code(value: string): string {
  return `<code>${esc(value)}</code>`;
}

/**
 * A link, or just the text when there is nothing to link to.
 *
 * Only http(s). Some of these hrefs are built from creator-supplied profile fields, and a
 * `javascript:` or `tg://` target inside a rendered link is a phishing primitive.
 */
export function a(href: string | null | undefined, text: string): string {
  if (!href || href.length > 400 || !/^https?:\/\//iu.test(href)) return esc(text);
  // No whitespace, no quote, no angle bracket, and nothing below U+0020. Escaping already makes
  // the attribute safe; this keeps the obviously-not-a-URL out of it as well. Written as a loop
  // rather than a character class so this file cannot come to contain the bytes it rejects.
  for (const ch of href) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || ch === '"' || ch === '<' || ch === '>') return esc(text);
  }
  return `<a href="${esc(href)}">${esc(text)}</a>`;
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1) return usd.format(value);
  const digits = abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatUsdCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1_000 ? `$${compact.format(value)}` : formatUsd(value);
}

/**
 * Token amounts run to hundreds of millions and stock amounts to a couple of units, so one
 * precision cannot serve both: rounding everything to whole numbers turned 2.11 NVDAc into "2".
 */
export function formatAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000) return compact.format(value);
  if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/u, '');
  return value.toPrecision(3).replace(/\.?0+$/u, '');
}

export function formatCount(value: number): string {
  return plain.format(value);
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/**
 * A share of the fixed supply, from whole basis points. A buy under one basis point still bought
 * something, and "0%" would say it bought nothing.
 */
export function formatShare(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '—';
  if (bps < 1) return '<0.01%';
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/u, '')}%`;
}

/** How long ago, in the coarsest unit that still says something. */
export function age(from: string | Date, now = new Date()): string {
  const ms = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

/** A wallet reads as its Basename when it has one, and as a short address when it does not. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function basescan(address: string): string {
  return `https://basescan.org/address/${address}`;
}

// ---------------------------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------------------------

/**
 * Above this the bar stops being a bar and starts being a wall.
 *
 * Set by looking at one in the channel: 48 wrapped to three rows on a phone and every large trade
 * looked identical to every other. Twenty fits two rows and still has room to grow into.
 */
const MAX_EMOJI = 20;

/**
 * How big this trade was, drawn.
 *
 * The step is derived from the threshold that qualified the trade rather than fixed in dollars, so
 * one bar means the same thing on a token doing $200 a day as on one doing $20,000. The cap is not
 * decoration: the only open-source buy bot with real code uses one emoji per $10 with no ceiling,
 * which renders a thousand of them for a $10,000 buy against a 4,096 character limit.
 */
export function bar(valueUsd: number, stepUsd: number, glyph: string): string {
  const step = stepUsd > 0 ? stepUsd : 1;
  const count = Math.min(MAX_EMOJI, Math.max(1, Math.floor(valueUsd / step)));
  return glyph.repeat(count);
}

// ---------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------

export type Post = { text: string; buttons: InlineButton[][]; preview?: string | null };

export type TokenFacts = {
  token: string;
  name: string;
  symbol: string;
  stockSymbol: string;
  stockAddress: string;
};

export type Holder = { address: string; sharePercent: number };

/** Everything a card says about a token, gathered once and shared by every kind of post. */
export type Snapshot = {
  priceUsd: number | null;
  fdvUsd: number | null;
  athUsd: number | null;
  volume24hUsd: number | null;
  change24hPercent: number | null;
  buys24h: number;
  sells24h: number;
  holders: number;
  topHolders: Holder[];
  topShare: number | null;
  launchedAt: string;
  creator: string;
  creatorName: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  poolId: string;
};

/** What only a launch card says: the launch's own facts, fixed when it happened. */
export type LaunchDetail = {
  /** At the opening tick, priced with the Chainlink value the factory read at launch. */
  openingPriceUsd: number | null;
  openingFdvUsd: number | null;
  /** The creator's buy inside the launch transaction; `amountStock` includes the swap fee. */
  creatorBuy: { supplyBps: number; amountStock: number; valueUsd: number | null } | null;
  /** The creator chose a profile they can change later, and has not locked it yet. */
  metadataEditable: boolean;
};

/** Both chart sites are in the text row; a button for one of them would just pick a favourite. */
export function buttons(appUrl: string, facts: TokenFacts): InlineButton[][] {
  return [
    [
      { text: '💱 Trade', url: `${appUrl}/token/${facts.token}` },
      { text: '👥 Holders', url: `${appUrl}/token/${facts.token}?tab=holders` },
    ],
  ];
}

/**
 * The block every card carries: what the token is, and where to go next.
 *
 * The links live in the text as well as on the buttons. A forwarded message keeps its text and
 * drops nothing, and the wallets and socials are far too many to be buttons.
 */
function card(appUrl: string, facts: TokenFacts, snap: Snapshot): string[] {
  const lines: string[] = [];

  lines.push(`🌐 Base @ Uniswap v4 · vs ${a(basescan(facts.stockAddress), facts.stockSymbol)}`);
  lines.push(`💰 ${esc(formatUsd(snap.priceUsd))} · 💎 FDV ${esc(formatUsdCompact(snap.fdvUsd))}${snap.athUsd ? ` · ⛰️ ATH ${esc(formatUsdCompact(snap.athUsd))}` : ''}`);

  const arrow = (snap.change24hPercent ?? 0) >= 0 ? '📈' : '📉';
  lines.push(
    `${arrow} 24h ${esc(formatPercent(snap.change24hPercent))} · 📊 ${esc(formatUsdCompact(snap.volume24hUsd))} · 🅑 ${esc(formatCount(snap.buys24h))} 🅢 ${esc(formatCount(snap.sells24h))}`,
  );
  lines.push(`🕰️ Age ${esc(age(snap.launchedAt))} · 👤 by ${a(basescan(snap.creator), snap.creatorName)}`);

  if (snap.topHolders.length > 0) {
    const top = snap.topHolders.map((h) => a(basescan(h.address), h.sharePercent.toFixed(1))).join('⋅');
    const share = snap.topShare === null ? '' : ` [${Math.round(snap.topShare)}%]`;
    lines.push(`👥 ${esc(formatCount(snap.holders))} holders · TH ${top}${esc(share)}`);
  } else {
    lines.push(`👥 ${esc(formatCount(snap.holders))} holders`);
  }

  // No "supply in pool, no admin" line. It is true of every token this launchpad has ever made,
  // so repeating it on every post is wallpaper rather than a fact about this one. It belongs on
  // the site, where someone reads it once.
  //
  // Words, not icons: a 🌍 next to a 🐦 is two indistinguishable smudges at the bottom of a post,
  // and the tap target of a single emoji on a phone is smaller than a fingertip.
  const tools = [
    a(snap.website, 'Web'),
    a(snap.twitter, 'X'),
    a(snap.telegram, 'TG'),
    a(`https://dexscreener.com/base/${snap.poolId}`, 'DexScreener'),
    // GeckoTerminal indexes v4 pools under the same pool id, verified against its own API.
    a(`https://www.geckoterminal.com/base/pools/${snap.poolId}`, 'Gecko'),
    a(`${appUrl}/token/${facts.token}`, 'Token'),
  ].filter((t) => t.startsWith('<a'));
  if (tools.length > 0) lines.push(`🔗 ${tools.join(' · ')}`);

  lines.push('');
  // <code> is tap-to-copy in Telegram, which is the only reason the address is here at all.
  lines.push(code(facts.token));
  return lines;
}

export function tradePost(
  appUrl: string,
  facts: TokenFacts,
  snap: Snapshot,
  detail: {
    side: 'buy' | 'sell';
    valueUsd: number;
    stepUsd: number;
    amountStock: number;
    amountToken: number;
    trader: string | null;
    traderName: string;
    shareOfDay: number | null;
    txHash: string;
    /** A level this trade carried the token past, said here rather than in a second post. */
    milestone?: number | null;
    /** The high it beat, if it set one. */
    newHighFrom?: number | null;
  },
): Post {
  const buy = detail.side === 'buy';
  const glyph = buy ? '🟢' : '🔴';
  const stock = `${formatAmount(detail.amountStock)} ${facts.stockSymbol}`;
  const token = `${formatAmount(detail.amountToken)} ${facts.symbol}`;
  // "2.17 NVDAc → 29.7M STOCK" leaves a reader working out which way the arrow points. Spelling
  // out what was given for what says it in the same space, and reverses correctly on a sell.
  const swapped = buy ? `${stock} for ${token}` : `${token} for ${stock}`;
  const lines = [
    `${glyph} ${a(`${appUrl}/token/${facts.token}`, facts.name)} · ${b(buy ? 'BUY' : 'SELL')}`,
    bar(detail.valueUsd, detail.stepUsd, glyph),
    `💵 ${b(formatUsd(detail.valueUsd))} · ${esc(swapped)}`,
  ];
  if (detail.shareOfDay !== null && detail.shareOfDay > 0) {
    // At the top of the range a percentage reads like a rounding artifact rather than a fact, and
    // "the only trade today" would be a stronger claim than the number supports.
    const share = detail.shareOfDay >= 0.9 ? "most of today's volume" : `${Math.round(detail.shareOfDay * 100)}% of today's volume`;
    // With a subject, because a bare fragment under a price reads as a caption for the price.
    lines.push(`🔥 ${esc(`This trade is ${share}`)}`);
  }
  if (detail.milestone) lines.push(`🎯 ${esc(`Carried it past ${formatUsdCompact(detail.milestone)}`)}`);
  if (detail.newHighFrom) lines.push(`⛰️ ${esc(`New high, beating ${formatUsdCompact(detail.newHighFrom)}`)}`);
  lines.push(
    `🧑 ${esc(buy ? 'Buyer' : 'Seller')} ${detail.trader ? a(basescan(detail.trader), detail.traderName) : esc(detail.traderName)} · ${a(`https://basescan.org/tx/${detail.txHash}`, 'tx ↗')}`,
  );
  lines.push('');
  lines.push(...card(appUrl, facts, snap));
  return { text: lines.join('\n'), buttons: buttons(appUrl, facts), preview: null };
}

/**
 * A launch says what is true at zero seconds old, which is almost none of what a trade card says.
 *
 * Reusing the trade card here printed "24h — · 📊 — · 🅑 0 🅢 0" and "0 holders": a row of dashes
 * under a headline, because a token that has just been created has no day behind it, no holders
 * outside the pool and no high to have reached. What it does have is an opening price, a stock it
 * is paired against, and whatever the creator chose at launch: a buy of their own in the same
 * transaction, and a profile they can still change.
 *
 * The price is the opening one from `launch`, never the snapshot's. A creator buy has already moved
 * the last trade price by the time this is sent, and announcing that as "opens at" would print the
 * price after the creator's buy as the price everyone else could have had.
 */
export function launchPost(appUrl: string, facts: TokenFacts, snap: Snapshot, launch: LaunchDetail): Post {
  const lines = [
    `🆕 ${a(`${appUrl}/token/${facts.token}`, facts.name)} · ${b(`$${facts.symbol}`)}`,
    `🌐 Base @ Uniswap v4 · trades against ${a(basescan(facts.stockAddress), facts.stockSymbol)}`,
    '',
    `💰 Opens at ${esc(formatUsd(launch.openingPriceUsd))} · 💎 FDV ${esc(formatUsdCompact(launch.openingFdvUsd))}`,
    // "Put in", not "in": a creator buy takes some of it straight back out in the same transaction.
    esc('🔒 1,000,000,000 supply, all of it put in the pool and no way to withdraw it'),
  ];
  const bought = launch.creatorBuy;
  if (bought) {
    const value = bought.valueUsd === null ? '' : ` ≈ ${formatUsd(bought.valueUsd)}`;
    lines.push(
      esc(`🧑‍💻 Creator bought ${formatShare(bought.supplyBps)} of supply at launch (${formatAmount(bought.amountStock)} ${facts.stockSymbol}${value})`),
    );
  }
  if (launch.metadataEditable) lines.push(esc('✏️ Profile editable by the creator'));
  lines.push(`👤 by ${a(basescan(snap.creator), snap.creatorName)}`);

  const tools = [
    a(snap.website, 'Web'),
    a(snap.twitter, 'X'),
    a(snap.telegram, 'TG'),
    a(`https://dexscreener.com/base/${snap.poolId}`, 'DexScreener'),
    a(`https://www.geckoterminal.com/base/pools/${snap.poolId}`, 'Gecko'),
    a(`${appUrl}/token/${facts.token}`, 'Token'),
  ].filter((t) => t.startsWith('<a'));
  if (tools.length > 0) lines.push(`🔗 ${tools.join(' · ')}`);
  lines.push('', code(facts.token));
  return {
    text: lines.join('\n'),
    buttons: buttons(appUrl, facts),
    // The token page renders its own share card, which is a better image than anything this
    // service could assemble and costs nothing to reference.
    preview: `${appUrl}/token/${facts.token}`,
  };
}

export function milestonePost(appUrl: string, facts: TokenFacts, snap: Snapshot, level: number): Post {
  const lines = [
    `🎯 ${a(`${appUrl}/token/${facts.token}`, facts.name)} passed ${b(formatUsdCompact(level))}`,
    '',
    ...card(appUrl, facts, snap),
  ];
  return { text: lines.join('\n'), buttons: buttons(appUrl, facts), preview: null };
}

export function athPost(appUrl: string, facts: TokenFacts, snap: Snapshot, previousUsd: number): Post {
  const lines = [
    `⛰️ ${a(`${appUrl}/token/${facts.token}`, facts.name)} · ${b('new high')}`,
    esc(`${formatUsd(snap.priceUsd)}, was ${formatUsd(previousUsd)}`),
    '',
    ...card(appUrl, facts, snap),
  ];
  return { text: lines.join('\n'), buttons: buttons(appUrl, facts), preview: null };
}

/**
 * One post instead of many.
 *
 * The indexer skips its poll sleep while catching up, so a restart after a long stop commits
 * thousands of blocks in seconds and hands the dispatcher an hour of history at once. Replaying
 * that into the channel one message at a time is how a channel gets muted.
 */
export function digestPost(appUrl: string, summary: { launches: number; trades: number; tokens: string[] }): Post {
  const parts: string[] = [];
  if (summary.launches > 0) parts.push(`${summary.launches} launch${summary.launches === 1 ? '' : 'es'}`);
  if (summary.trades > 0) parts.push(`${summary.trades} large trade${summary.trades === 1 ? '' : 's'}`);
  const lines = [`📊 ${b('While the channel was quiet')}`, '', esc(parts.join(' · ') || 'Nothing to report')];
  if (summary.tokens.length > 0) {
    const shown = summary.tokens.slice(0, 8).map((t) => `$${t}`).join(', ');
    const more = summary.tokens.length > 8 ? ` and ${summary.tokens.length - 8} more` : '';
    lines.push('', esc(shown + more));
  }
  return { text: lines.join('\n'), buttons: [[{ text: '📊 Markets', url: `${appUrl}/markets` }]], preview: null };
}

export function fits(post: Post): boolean {
  return post.text.length <= TEXT_LIMIT;
}

/**
 * Drops whole lines off the end until the post fits.
 *
 * Telegram rejects anything over 4,096 characters, and the transport used to `slice()` to the
 * limit — which cuts through a tag and turns a too-long post into a 400 and a silent loss. Names,
 * symbols and three creator-supplied URLs all flow into a card, so "it cannot get that long" was
 * not something this module could promise. Dropping lines loses the tail; slicing loses the post.
 */
export function trim(post: Post): Post {
  if (fits(post)) return post;
  const lines = post.text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > TEXT_LIMIT) lines.pop();
  return { ...post, text: lines.join('\n').slice(0, TEXT_LIMIT) };
}
