import { openingPriceUsd, SUPPLY_RAW } from '@stockpair/core';
import type { AlertRow, MarketRow } from '@stockpair/core/db';

import type { LaunchDetail } from './render';

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

/** The parts of the market row a card's links come from. */
export type LinkRowFacts = Pick<
  MarketRow,
  'metadata_editable' | 'website' | 'twitter' | 'telegram' | 'profile_website' | 'profile_twitter' | 'profile_telegram'
>;

export type Links = { website: string | null; twitter: string | null; telegram: string | null };

/**
 * Where a card's Web, X and TG links point, in the order the token page uses: the creator's signed
 * profile field by field, then the launch row, which holds the profile JSON from the launch or, for
 * an editable token, from its latest onchain update.
 *
 * An editable token is changed onchain only, so a signed profile never applies to it.
 */
export function toLinks(row: LinkRowFacts): Links {
  const signed = row.metadata_editable ? null : row;
  return {
    website: signed?.profile_website ?? row.website ?? null,
    twitter: signed?.profile_twitter ?? row.twitter ?? null,
    // `?? null` as well: a row read before the launch row had this column carries undefined.
    telegram: signed?.profile_telegram ?? row.telegram ?? null,
  };
}

/** From `CreatorBought`. Raw amounts are decimal strings, because a bigint does not survive JSON. */
export type CreatorBuyPayload = { stockInRaw: string; feeRaw: string; tokensOutRaw: string; supplyBps: number };

/**
 * What the indexer queues with a launch, beyond the name and symbol the market row also has.
 *
 * All optional: rows queued before buy-at-launch and editable profiles existed carry none of these,
 * and one of them still in the outbox after a deploy has to render rather than wedge the queue.
 */
export type LaunchPayload = {
  openingPriceUsd?: number | null;
  creatorBuy?: CreatorBuyPayload | null;
  metadataEditable?: boolean;
};

function rawAmount(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d{1,78}$/u.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The parts of the launch row a launch card falls back on. */
export type LaunchRowFacts = Pick<
  MarketRow,
  | 'opening_sqrt_price_x96'
  | 'token_is_currency0'
  | 'stock_decimals'
  | 'stock_usd8_at_launch'
  | 'metadata_editable'
  | 'metadata_locked_at'
>;

/** Recomputed from the launch row, for a payload queued before the indexer sent the figure. */
function openingFromRow(row: LaunchRowFacts): number | null {
  try {
    return positive(
      openingPriceUsd(
        BigInt(row.opening_sqrt_price_x96),
        row.token_is_currency0,
        Number(row.stock_decimals),
        BigInt(row.stock_usd8_at_launch),
      ),
    );
  } catch {
    return null;
  }
}

function creatorBuyOf(value: unknown, stockDecimals: number, stockUsd: number | null): LaunchDetail['creatorBuy'] {
  if (value === null || typeof value !== 'object') return null;
  const buy = value as Record<string, unknown>;
  const stockIn = rawAmount(buy.stockInRaw);
  const tokensOut = rawAmount(buy.tokensOutRaw);
  if (stockIn === null || tokensOut === null || tokensOut === 0n) return null;
  // The indexer's figure when it sent one, so this card and the token page's "Dev buy" agree;
  // otherwise the same floor it uses.
  const sent = rawAmount(buy.supplyBps);
  const supplyBps = Number(sent !== null && sent <= 10_000n ? sent : (tokensOut * 10_000n) / SUPPLY_RAW);
  const amountStock = Number(stockIn) / 10 ** stockDecimals;
  return { supplyBps, amountStock, valueUsd: stockUsd === null ? null : amountStock * stockUsd };
}

/**
 * What a launch card says about the launch itself.
 *
 * The launch's facts come from the payload, fixed when the launch was indexed. The market row is
 * read at send time, and by then a buy in the launch transaction has already moved its last price.
 * Dollars use the Chainlink value the factory read at launch, not today's.
 */
export function toLaunch(row: LaunchRowFacts, payload: unknown): LaunchDetail {
  const queued: LaunchPayload = payload !== null && typeof payload === 'object' ? payload : {};
  const stockUsd = positive(Number(row.stock_usd8_at_launch) / 1e8);
  const openingPrice = positive(queued.openingPriceUsd) ?? openingFromRow(row);
  const chosen = typeof queued.metadataEditable === 'boolean' ? queued.metadataEditable : row.metadata_editable === true;
  return {
    openingPriceUsd: openingPrice,
    openingFdvUsd: openingPrice === null ? null : openingPrice * SUPPLY,
    creatorBuy: creatorBuyOf(queued.creatorBuy, Number(row.stock_decimals), stockUsd),
    // A backlog can hold a card long enough for the creator to lock the profile first, and then
    // "editable" would be false the moment it was posted.
    metadataEditable: chosen && row.metadata_locked_at == null,
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
  /** The creator's buy inside the launch transaction. Absent on rows queued before it existed. */
  launchBuy?: boolean;
};

/**
 * The creator's buy at launch is already a line on the launch card. A trade post as well would
 * announce the same buy twice, seconds apart.
 */
export function isLaunchBuy(payload: TradePayload): boolean {
  return payload.launchBuy === true;
}

export type Thresholds = { minTradeUsd: number; minTradeShare: number; minTradeFloorUsd: number };

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
  // The share rule needs a floor of its own. A token doing $5 a day makes a $1 trade 20% of its
  // volume, and "large" has to mean something to a reader, not just to the arithmetic.
  const clearsShare =
    shareOfDay !== null && shareOfDay >= limits.minTradeShare && valueUsd >= limits.minTradeFloorUsd;
  if (!clearsFloor && !clearsShare) return { post: false };

  // The bar is drawn against the bar this trade had to clear, so one length means the same thing
  // on a quiet token as on a busy one.
  //
  // The share gate is whichever of its two halves actually bound. Using the percentage alone put
  // every trade at the cap: with a $167 day the share basis is $25, and a $108 trade is 26 steps
  // of it — so $108 and $475 drew identical bars.
  const shareBasis = Math.max(limits.minTradeFloorUsd, (dayVolume ?? 0) * limits.minTradeShare);
  const basis = clearsFloor ? limits.minTradeUsd : shareBasis;
  // Thirds rather than sixths: a trade at the threshold gets a stub, and the cap is nearly seven
  // times it, which covers the range these tokens actually trade in.
  const stepUsd = Math.max(basis / 3, 1);
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
