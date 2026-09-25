import { sha256, stringToBytes } from 'viem';

import { SUPPLY_RAW } from '@stockpair/core';
import type { MarketRow } from '@stockpair/core/db';

import { ipfsToHttp, publicEnv } from './env';
import type { LaunchInfo, ProfileInfo } from './types';

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
  /** The factory and hook that launched this token; null only for rows not yet backfilled (the oldest deployment). */
  factory: string | null;
  hook: string | null;
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

/**
 * The image a token shows. A token launched with an editable profile is changed onchain only, so a
 * signed off-chain profile never applies to it; every other token keeps the signed override.
 */
export function effectiveImageUri(row: Pick<MarketRow, 'metadata_editable' | 'image_uri'> & { profile_image_uri?: string | null }): string | null {
  if (row.metadata_editable) return row.image_uri;
  return row.profile_image_uri ?? row.image_uri;
}

/**
 * `ipfs://` and a bare CID, nothing else: the one form whose bytes cannot change behind the same URI.
 * A path after the CID can climb out of it with `..` (to a mutable /ipns/ name on the gateway), and
 * a web address serves whatever its owner puts there.
 */
export function isBareIpfsUri(uri: string | null | undefined): boolean {
  return typeof uri === 'string' && /^ipfs:\/\/[A-Za-z0-9]{46,128}$/u.test(uri);
}

/**
 * Whether what a URI serves can change behind it. Nothing, an inline `data:` document and any
 * `ipfs://` path that stays under its CID are fixed; the first factory accepted all of these, so
 * its tokens must not be told their profile is mutable. Only a path that can climb out of the CID
 * (`..`, a backslash) or a web address is.
 */
export function isFixedContentUri(uri: string | null | undefined): boolean {
  if (!uri) return true;
  if (uri.startsWith('data:')) return true;
  return uri.startsWith('ipfs://') && ipfsToHttp(uri) !== null;
}

/** First 12 hex of sha256(uri): changes whenever the image does, so the proxy URL can be cached hard. */
export function imageVersion(uri: string): string {
  return sha256(stringToBytes(uri)).slice(2, 14);
}

/**
 * Our own origin's copy of the image, versioned by what it points at; null when there is none.
 * Absolute, because the JSON API is read from other origins too: the BStocks app renders these
 * straight into an <img> on basestocks.finance, where a relative path would 404.
 */
export function imageProxyUrl(token: string, uri: string | null): string | null {
  if (!uri || !ipfsToHttp(uri)) return null;
  return `${publicEnv.appUrl.replace(/\/+$/u, '')}/api/tokens/${token.toLowerCase()}/image?v=${imageVersion(uri)}`;
}

export function toMarketView(row: MarketRow, now = new Date()): MarketView {
  // Editable tokens have one editing path, onchain; the signed profile is merged only for the rest.
  const signed = row.metadata_editable ? null : row;
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
    imageUrl: imageProxyUrl(row.token, effectiveImageUri(row)),
    description: signed?.profile_description ?? row.description,
    website: signed?.profile_website ?? row.website,
    twitter: signed?.profile_twitter ?? row.twitter ?? null,
    telegram: signed?.profile_telegram ?? row.telegram ?? null,
    profileUpdatedAt: signed?.profile_updated_at ? new Date(signed.profile_updated_at).toISOString() : null,
    creator: row.creator,
    factory: row.factory ?? null,
    hook: row.hook ?? null,
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

/** The deployment that launched the token and the creator's buy at launch, if any. */
export function toLaunchInfo(row: MarketRow): LaunchInfo {
  const tokensOut = row.creator_buy_token_raw === null ? 0n : BigInt(row.creator_buy_token_raw);
  return {
    factory: row.factory ?? null,
    hook: row.hook ?? null,
    creatorBuy:
      tokensOut > 0n
        ? {
            stockInRaw: String(row.creator_buy_stock_raw ?? '0'),
            feeRaw: String(row.creator_buy_fee_raw ?? '0'),
            tokensOutRaw: tokensOut.toString(),
            supplyBps: Number((tokensOut * 10_000n) / SUPPLY_RAW),
            txHash: row.tx_hash,
          }
        : null,
  };
}

/** Where the profile stands onchain. Every token from before editable profiles reads `immutable`. */
export function toProfileInfo(row: MarketRow): ProfileInfo {
  const contractUri = row.current_contract_uri ?? row.contract_uri;
  // The factory checks only the URI, never the document behind it, so the image that document
  // names is checked too. No image means nothing mutable is shown.
  const image = effectiveImageUri(row);
  return {
    onchain: !row.metadata_editable ? 'immutable' : row.metadata_locked_at ? 'locked' : 'editable',
    contractUri,
    contentAddressed: isFixedContentUri(contractUri) && isFixedContentUri(image),
    updates: Number(row.profile_updates ?? 0),
    lastUpdatedAt: row.profile_updated_onchain_at ? new Date(row.profile_updated_onchain_at).toISOString() : null,
    lockedAt: row.metadata_locked_at ? new Date(row.metadata_locked_at).toISOString() : null,
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
