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

export function formatAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1_000 ? compact.format(value) : plain.format(value);
}

export function formatUnits(raw: string, decimals: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}

/** A wallet reads as its Basename when it has one, and as a short address when it does not. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// ---------------------------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------------------------

/** Above this the bar stops being a bar and starts being a wall. */
const MAX_EMOJI = 48;

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
};

export function links(appUrl: string, token: string, poolId: string | null): InlineButton[][] {
  const row: InlineButton[] = [{ text: '💱 Trade', url: `${appUrl}/token/${token}` }];
  if (poolId) row.push({ text: '📊 Chart', url: `https://dexscreener.com/base/${poolId}` });
  row.push({ text: '👥 Holders', url: `${appUrl}/token/${token}?tab=holders` });
  return [row];
}

export function launchPost(
  appUrl: string,
  facts: TokenFacts,
  detail: { creator: string; fdvUsd: number | null; poolId: string | null },
): Post {
  const lines = [
    `🆕 ${b('New launch')}`,
    '',
    `${b(facts.name)} · ${esc(`$${facts.symbol}`)}`,
    `Trades against ${esc(facts.stockSymbol)}`,
    `Creator ${esc(detail.creator)}`,
    '',
    `Supply 1,000,000,000 · MCap ${esc(formatUsdCompact(detail.fdvUsd))}`,
  ];
  return {
    text: lines.join('\n'),
    buttons: links(appUrl, facts.token, detail.poolId),
    // The token page renders its own share card, which is a better image than anything this
    // service could assemble and costs nothing to reference.
    preview: `${appUrl}/token/${facts.token}`,
  };
}

export function tradePost(
  appUrl: string,
  facts: TokenFacts,
  detail: {
    side: 'buy' | 'sell';
    valueUsd: number;
    stepUsd: number;
    amountStock: number;
    amountToken: number;
    trader: string;
    shareOfDay: number | null;
    fdvUsd: number | null;
    change24h: number | null;
    poolId: string | null;
  },
): Post {
  const buy = detail.side === 'buy';
  const glyph = buy ? '🟢' : '🔴';
  const lines = [
    `${glyph} ${b(facts.name)} · ${buy ? 'large buy' : 'large sell'}`,
    '',
    bar(detail.valueUsd, detail.stepUsd, glyph),
    `${b(formatUsd(detail.valueUsd))} · ${esc(`${formatAmount(detail.amountStock)} ${facts.stockSymbol}`)}`,
    esc(`${formatAmount(detail.amountToken)} ${facts.symbol}`),
  ];
  if (detail.shareOfDay !== null && detail.shareOfDay > 0) {
    lines.push(esc(`${Math.round(detail.shareOfDay * 100)}% of today's volume`));
  }
  lines.push('', `👤 ${esc(detail.trader)}`);
  const change = detail.change24h === null ? null : `${detail.change24h >= 0 ? '+' : ''}${detail.change24h.toFixed(1)}%`;
  lines.push(`💰 MCap ${esc(formatUsdCompact(detail.fdvUsd))}${change ? esc(` · 24h ${change}`) : ''}`);
  return { text: lines.join('\n'), buttons: links(appUrl, facts.token, detail.poolId), preview: null };
}

export function milestonePost(
  appUrl: string,
  facts: TokenFacts,
  detail: { level: number; holders: number; trades: number; poolId: string | null },
): Post {
  const lines = [
    `🎯 ${b(facts.name)} passed ${esc(formatUsdCompact(detail.level))}`,
    '',
    esc(`${plain.format(detail.holders)} holders · ${plain.format(detail.trades)} trades since launch`),
  ];
  return { text: lines.join('\n'), buttons: links(appUrl, facts.token, detail.poolId), preview: null };
}

export function athPost(
  appUrl: string,
  facts: TokenFacts,
  detail: { priceUsd: number; previousUsd: number; poolId: string | null },
): Post {
  const lines = [
    `📈 ${b(facts.name)} · new high`,
    '',
    b(formatUsd(detail.priceUsd)),
    esc(`Previous ${formatUsd(detail.previousUsd)}`),
  ];
  return { text: lines.join('\n'), buttons: links(appUrl, facts.token, detail.poolId), preview: null };
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
  const lines = [
    `📊 ${b('While the channel was quiet')}`,
    '',
    esc(parts.join(' · ') || 'Nothing to report'),
  ];
  if (summary.tokens.length > 0) {
    const shown = summary.tokens.slice(0, 8).map((t) => `$${t}`).join(', ');
    const more = summary.tokens.length > 8 ? ` and ${summary.tokens.length - 8} more` : '';
    lines.push('', esc(shown + more));
  }
  return {
    text: lines.join('\n'),
    buttons: [[{ text: '📊 Markets', url: `${appUrl}/markets` }]],
    preview: null,
  };
}

/** Nothing this module builds should ever be able to exceed Telegram's limit; this is the proof. */
export function fits(post: Post): boolean {
  return post.text.length <= TEXT_LIMIT;
}
