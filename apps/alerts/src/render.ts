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
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
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
  if (!href || !/^https?:\/\//iu.test(href)) return esc(text);
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
  },
): Post {
  const buy = detail.side === 'buy';
  const glyph = buy ? '🟢' : '🔴';
  const lines = [
    `${glyph} ${a(`${appUrl}/token/${facts.token}`, facts.name)} · ${b(buy ? 'BUY' : 'SELL')}`,
    bar(detail.valueUsd, detail.stepUsd, glyph),
    `${b(formatUsd(detail.valueUsd))} · ${esc(`${formatAmount(detail.amountStock)} ${facts.stockSymbol}`)} → ${esc(`${formatAmount(detail.amountToken)} ${facts.symbol}`)}`,
  ];
  if (detail.shareOfDay !== null && detail.shareOfDay > 0) {
    // At the top of the range a percentage reads like a rounding artifact rather than a fact, and
    // "the only trade today" would be a stronger claim than the number supports.
    lines.push(
      esc(detail.shareOfDay >= 0.9 ? "most of today's volume" : `${Math.round(detail.shareOfDay * 100)}% of today's volume`),
    );
  }
  lines.push(
    `🧑 ${detail.trader ? a(basescan(detail.trader), detail.traderName) : esc(detail.traderName)} · ${a(`https://basescan.org/tx/${detail.txHash}`, 'tx ↗')}`,
  );
  lines.push('');
  lines.push(...card(appUrl, facts, snap));
  return { text: lines.join('\n'), buttons: buttons(appUrl, facts), preview: null };
}

export function launchPost(appUrl: string, facts: TokenFacts, snap: Snapshot): Post {
  const lines = [
    `🆕 ${a(`${appUrl}/token/${facts.token}`, facts.name)} · ${b(`$${facts.symbol}`)}`,
    esc('1,000,000,000 supply, all of it in the pool at launch'),
    '',
    ...card(appUrl, facts, snap),
  ];
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

/** Nothing this module builds should ever be able to exceed Telegram's limit; this is the proof. */
export function fits(post: Post): boolean {
  return post.text.length <= TEXT_LIMIT;
}
