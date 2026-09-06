import 'server-only';

import { parseAbi, type Address, type Hex } from 'viem';

import { BASE_CONTRACTS, stockPairHookAbi } from '@stockpair/core';
import { readMarket, tokenFeeSummary, tokenLifetime, type Db } from '@stockpair/core/db';

import { cached, TTL } from './cache.server';
import { getPublicClient, serverDeployment } from './chain.server';
import { poolReserves } from './liquidity';
import { toMarketView, type MarketView } from './market-view';
import type { TokenDetails, TokenFees, TokenLifetime, TokenPool } from './types';

const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);

/** Where else a trader may want to look at this token. All public explorers keyed by the token address. */
export function externalLinks(token: string): TokenDetails['links'] {
  return {
    basescan: `https://basescan.org/token/${token}`,
    dexscreener: `https://dexscreener.com/base/${token}`,
    geckoterminal: `https://www.geckoterminal.com/base/tokens/${token}`,
    uniswap: `https://app.uniswap.org/explore/tokens/base/${token}`,
  };
}

export async function readMarketCached(db: Db, token: string): Promise<MarketView | null> {
  return cached(`market:${token}`, TTL.market, async () => {
    const row = await readMarket(db, token);
    return row ? toMarketView(row) : null;
  });
}

/** Pool price and the current hook fee, straight from the chain (memoised for a few seconds). */
async function readPoolState(poolId: Hex): Promise<{ sqrtPriceX96: bigint; feeBps: number } | null> {
  const deployment = serverDeployment();
  if (!deployment) return null;
  return cached(`pool:${poolId}`, TTL.chain, async () => {
    const client = getPublicClient();
    const [slot0, feeBps] = await Promise.all([
      client.readContract({ address: BASE_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }),
      client.readContract({ address: deployment.hook, abi: stockPairHookAbi, functionName: 'currentFeeBps', args: [poolId] }),
    ]);
    return { sqrtPriceX96: slot0[0], feeBps: Number(feeBps) };
  }).catch(() => null);
}

async function readCreatorClaimable(stock: Address, creator: Address): Promise<bigint | null> {
  const deployment = serverDeployment();
  if (!deployment) return null;
  return cached(`claimable:${stock}:${creator}`, TTL.chain, async () => {
    const client = getPublicClient();
    return client.readContract({ address: deployment.hook, abi: stockPairHookAbi, functionName: 'claimable', args: [stock, creator] });
  }).catch(() => null);
}

/** Everything the token page shows beyond the market row: fees, lifetime figures, pool reserves. */
export async function readTokenDetails(db: Db, market: MarketView): Promise<Omit<TokenDetails, 'market'>> {
  const stockUnit = 10 ** market.stock.decimals;
  const usd = (stockAmount: number) => (market.stockUsd === null ? null : stockAmount * market.stockUsd);
  const [feeRow, lifeRow, poolState, claimableRaw] = await Promise.all([
    cached(`fees:${market.token}`, TTL.list, () => tokenFeeSummary(db, market.token)),
    cached(`lifetime:${market.token}`, TTL.list, () => tokenLifetime(db, market.token)),
    readPoolState(market.poolId as Hex),
    readCreatorClaimable(market.stock.address as Address, market.creator as Address),
  ]);

  const totalStock = Number(feeRow.total_raw) / stockUnit;
  const creatorStock = Number(feeRow.creator_raw) / stockUnit;
  const platformStock = Number(feeRow.platform_raw) / stockUnit;
  const claimableStock = claimableRaw === null ? null : Number(claimableRaw) / stockUnit;
  const fees: TokenFees = {
    totalStock,
    creatorStock,
    platformStock,
    totalUsd: usd(totalStock),
    creatorUsd: usd(creatorStock),
    platformUsd: usd(platformStock),
    events: Number(feeRow.events),
    claimableStock,
    claimableUsd: claimableStock === null ? null : usd(claimableStock),
  };

  const volumeStock = Number(lifeRow.volume_stock_raw) / stockUnit;
  const lifetime: TokenLifetime = {
    trades: Number(lifeRow.trades),
    buys: Number(lifeRow.buys),
    sells: Number(lifeRow.sells),
    volumeStock,
    volumeUsd: usd(volumeStock),
    uniqueTraders: Number(lifeRow.unique_traders),
    creatorTrades: Number(lifeRow.creator_trades),
    creatorBought: Number(lifeRow.creator_bought_raw) / 1e18,
    creatorSold: Number(lifeRow.creator_sold_raw) / 1e18,
    firstTradeAt: lifeRow.first_trade_at ? new Date(lifeRow.first_trade_at).toISOString() : null,
    day: {
      trades: Number(lifeRow.trades_24h),
      buys: Number(lifeRow.buys_24h),
      sells: Number(lifeRow.sells_24h),
      volumeStock: Number(lifeRow.volume_24h_stock_raw) / stockUnit,
      volumeUsd: usd(Number(lifeRow.volume_24h_stock_raw) / stockUnit),
      traders: Number(lifeRow.traders_24h),
      creatorTrades: Number(lifeRow.creator_trades_24h),
    },
  };

  let pool: TokenPool = null;
  if (poolState) {
    const reserves = poolReserves({
      sqrtPriceX96: poolState.sqrtPriceX96,
      tickLower: market.tickLower,
      tickUpper: market.tickUpper,
      liquidity: BigInt(market.liquidity),
      tokenIsCurrency0: market.tokenIsCurrency0,
      stockDecimals: market.stock.decimals,
    });
    pool = {
      liquidity: market.liquidity,
      tokenReserve: reserves.token,
      stockReserve: reserves.stock,
      stockReserveUsd: usd(reserves.stock),
      tokenShareOfSupply: reserves.tokenShareOfSupply,
      sqrtPriceX96: poolState.sqrtPriceX96.toString(),
      feeBps: poolState.feeBps,
    };
  }

  return { fees, lifetime, pool, links: externalLinks(market.token) };
}
