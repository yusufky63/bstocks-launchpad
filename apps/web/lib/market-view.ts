import type { MarketRow } from '@stockpair/core/db';

import { ipfsToHttp } from './env';

/** What the UI renders for a market; every number is derived, none is invented. */
export type MarketView = {
  token: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  description: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  /** When the creator last updated the profile with a signed message; null when only launch metadata is shown. */
  profileUpdatedAt: string | null;
  creator: string;
  stock: { address: string; symbol: string; ticker: string; decimals: number };
  poolId: string;
  tokenIsCurrency0: boolean;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  launchedAt: string;
  /** Whole stock per whole token; null before the first trade. */
  priceInStock: number | null;
  /** Token price in USD; null when either the pool price or the stock quote is missing. */
  priceUsd: number | null;
  fdvUsd: number | null;
  change24hPercent: number | null;
  volume24hStock: number;
  volume24hUsd: number | null;
  trades24h: number;
  /** Since launch, not the last day. */
  volumeUsd: number | null;
  trades: number;
  holders: number;
  stockUsd: number | null;
  stockFeedUpdatedAt: string | null;
  stockFeedStatus: 'live' | 'holding' | 'unknown';
  lastTradeAt: string | null;
  txHash: string;
  blockNumber: string;
};

const SUPPLY = 1_000_000_000;

export function feedStatus(feedUpdatedAt: Date | string | null): MarketView['stockFeedStatus'] {
  if (!feedUpdatedAt) return 'unknown';
  const age = Date.now() - new Date(feedUpdatedAt).getTime();
  // Base documents these feeds as updating on a 0.5% move or a 24-hour heartbeat, holding the last
  // close outside market hours. So age alone cannot tell a halted oracle from a quiet Saturday, and
  // this used to call anything over three hours "paused" — an assertion the data does not support.
  // "holding" says only what we observed: the last reading is old and is what we are pricing with.
  // A genuinely paused oracle is a registry flag we do not read; do not infer it from a timestamp.
  return age < 3 * 60 * 60 * 1000 ? 'live' : 'holding';
}

export function toMarketView(row: MarketRow, now = new Date()): MarketView {
  const stockUsd = row.stock_usd8 === null ? null : Number(row.stock_usd8) / 1e8;
  const priceInStock = row.last_price === null ? null : Number(row.last_price);
  const priceUsd = priceInStock !== null && stockUsd !== null ? priceInStock * stockUsd : null;
  const ago = row.price_24h_ago === null ? null : Number(row.price_24h_ago);
  const stockUnit = 10 ** Number(row.stock_decimals);
  const volume24hStock = Number(row.volume_24h_stock_raw) / stockUnit;
  const volumeStock = Number(row.volume_all_stock_raw) / stockUnit;
  return {
    token: row.token,
    name: row.name,
    symbol: row.symbol,
    // A creator-signed profile overrides the launch metadata field by field.
    imageUrl: ipfsToHttp(row.profile_image_uri ?? row.image_uri),
    description: row.profile_description ?? row.description,
    website: row.profile_website ?? row.website,
    twitter: row.profile_twitter ?? row.twitter ?? null,
    telegram: row.profile_telegram ?? null,
    profileUpdatedAt: row.profile_updated_at ? new Date(row.profile_updated_at).toISOString() : null,
    creator: row.creator,
    stock: {
      address: row.stock,
      symbol: row.stock_symbol,
      ticker: row.stock_ticker,
      decimals: Number(row.stock_decimals),
    },
    poolId: row.pool_id,
    tokenIsCurrency0: row.token_is_currency0,
    tickLower: Number(row.tick_lower),
    tickUpper: Number(row.tick_upper),
    liquidity: String(row.liquidity),
    launchedAt: new Date(row.launched_at).toISOString(),
    priceInStock,
    priceUsd,
    fdvUsd: priceUsd === null ? null : priceUsd * SUPPLY,
    change24hPercent:
      priceInStock !== null && ago !== null && ago > 0 ? ((priceInStock - ago) / ago) * 100 : null,
    volume24hStock,
    volume24hUsd: stockUsd === null ? null : volume24hStock * stockUsd,
    trades24h: Number(row.trades_24h),
    volumeUsd: stockUsd === null ? null : volumeStock * stockUsd,
    trades: Number(row.trades_all),
    holders: Number(row.holder_count),
    stockUsd,
    stockFeedUpdatedAt: row.feed_updated_at ? new Date(row.feed_updated_at).toISOString() : null,
    stockFeedStatus: feedStatus(row.feed_updated_at),
    lastTradeAt: row.last_trade_at ? new Date(row.last_trade_at).toISOString() : null,
    txHash: row.tx_hash,
    blockNumber: String(row.block_number),
  };
}

export function launchedAgo(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
