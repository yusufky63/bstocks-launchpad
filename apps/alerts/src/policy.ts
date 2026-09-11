import type { AlertRow, MarketRow } from '@stockpair/core/db';

/**
 * What the channel says, and what it keeps to itself.
 *
 * The indexer queues everything it sees and takes no view. Deciding is here, in the service that
 * can be redeployed without touching the chain sync, because thresholds are the setting most
 * likely to be wrong on the first try.
 *
 * The governing constraint is that nobody can filter this channel. When each reader can mute what
 * they do not want, a bot can afford to be chatty; when everyone gets the same feed and the only
 * control is leaving, volume is the product. So the bar is high and the defaults are narrow.
 */

const SUPPLY = 1_000_000_000;

/** Every level a token can pass, once, ever. */
export const MCAP_LEVELS = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000] as const;

export type Market = {
  token: string;
  name: string;
  symbol: string;
  poolId: string;
  stockSymbol: string;
  stockDecimals: number;
  stockUsd: number | null;
  priceInStock: number | null;
  priceUsd: number | null;
  fdvUsd: number | null;
  change24hPercent: number | null;
  volume24hUsd: number | null;
  holders: number;
  trades: number;
};

export function toMarket(row: MarketRow): Market {
  const stockUsd = row.stock_usd8 === null ? null : Number(row.stock_usd8) / 1e8;
  const priceInStock = row.last_price === null ? null : Number(row.last_price);
  const priceUsd = priceInStock !== null && stockUsd !== null ? priceInStock * stockUsd : null;
  const stockUnit = 10 ** Number(row.stock_decimals);
  const volume24hStock = Number(row.volume_24h_stock_raw) / stockUnit;
  // Both sides in stock terms, so a move in the stock's own USD price does not read as a move in
  // the token.
  const ago = row.price_24h_ago === null ? null : Number(row.price_24h_ago);
  return {
    token: row.token,
    name: row.name,
    symbol: row.symbol,
    poolId: row.pool_id,
    stockSymbol: row.stock_symbol,
    stockDecimals: Number(row.stock_decimals),
    stockUsd,
    priceInStock,
    priceUsd,
    fdvUsd: priceUsd === null ? null : priceUsd * SUPPLY,
    change24hPercent: priceInStock !== null && ago !== null && ago > 0 ? ((priceInStock - ago) / ago) * 100 : null,
    volume24hUsd: stockUsd === null ? null : volume24hStock * stockUsd,
    holders: Number(row.holder_count),
    trades: Number(row.trades_all),
  };
}

export type TradePayload = {
  side: 'buy' | 'sell';
  amountTokenRaw: string;
  amountStockRaw: string;
  priceTokenInStock: string;
  trader: string | null;
  txHash: string;
  blockTime: string;
  stockDecimals: number;
  stockUsd8: string | null;
};

export type Thresholds = { minTradeUsd: number; minTradeShare: number };

export type TradeVerdict =
  | { post: false }
  | { post: true; valueUsd: number; stepUsd: number; amountStock: number; amountToken: number; shareOfDay: number | null };

/**
 * Is this trade big enough to be worth everyone's attention?
 *
 * Two ways to qualify, because one number cannot serve both ends of the range. An absolute floor
 * alone means a token doing $200 a day is never heard from; a share of daily volume alone means
 * the first trade after a quiet night is always "significant". A trade clears the bar by being
 * large in dollars *or* large relative to the day the token is having.
 */
export function judgeTrade(payload: TradePayload, market: Market, limits: Thresholds): TradeVerdict {
  const stockUnit = 10 ** payload.stockDecimals;
  const amountStock = Number(payload.amountStockRaw) / stockUnit;
  const amountToken = Number(payload.amountTokenRaw) / 1e18;
  // The price the stock was at when the trade happened, not now.
  const stockUsd = payload.stockUsd8 === null ? market.stockUsd : Number(payload.stockUsd8) / 1e8;
  if (stockUsd === null || !Number.isFinite(stockUsd)) return { post: false };

  const valueUsd = amountStock * stockUsd;
  if (!Number.isFinite(valueUsd) || valueUsd <= 0) return { post: false };

  // The trade counts towards the day it is being compared against. Dividing by a window that
  // happens to exclude it produces "350% of today's volume", which reads as a broken number
  // rather than a big trade.
  const dayVolume = market.volume24hUsd === null ? null : Math.max(market.volume24hUsd, valueUsd);
  const shareOfDay = dayVolume !== null && dayVolume > 0 ? valueUsd / dayVolume : null;

  const clearsFloor = valueUsd >= limits.minTradeUsd;
  const clearsShare = shareOfDay !== null && shareOfDay >= limits.minTradeShare;
  if (!clearsFloor && !clearsShare) return { post: false };

  // One bar means the same thing on a quiet token as on a busy one: the step is whichever
  // threshold this trade actually cleared, divided into six.
  const basis = clearsFloor ? limits.minTradeUsd : (dayVolume ?? limits.minTradeUsd) * limits.minTradeShare;
  const stepUsd = Math.max(basis / 6, 1);
  return { post: true, valueUsd, stepUsd, amountStock, amountToken, shareOfDay };
}

/**
 * The highest level this token has now passed, or null if it has not passed a new one.
 *
 * `alreadyMarked` is the last level announced, read from the database rather than held in memory,
 * so a restart cannot re-announce every level every token has ever crossed.
 */
export function nextMilestone(fdvUsd: number | null, alreadyMarked: number): number | null {
  if (fdvUsd === null || !Number.isFinite(fdvUsd)) return null;
  let reached: number | null = null;
  for (const level of MCAP_LEVELS) {
    if (fdvUsd >= level && level > alreadyMarked) reached = level;
  }
  return reached;
}

/** A new high, but only if it beats the last one by enough to be news. */
export function isNewHigh(priceUsd: number | null, previousUsd: number, minGain = 0.05): boolean {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return false;
  if (previousUsd <= 0) return false;
  return priceUsd >= previousUsd * (1 + minGain);
}

export function isLaunch(alert: AlertRow): boolean {
  return alert.kind === 'launch';
}
