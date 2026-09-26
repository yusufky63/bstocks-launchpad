import 'server-only';

import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';

import { BASE_CONTRACTS, findStock, stockPairFactoryAbi, stockPairHookAbi, stockPerTokenE30, e30ToNumber } from '@stockpair/core';
import { readMarket, type Db } from '@stockpair/core/db';

import { cached } from './cache.server';
import { getPublicClient, serverDeployments } from './chain.server';
import { hookOf } from './deployments';
import { readLaunchOnchain } from './onchain.server';

const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const TICK_SPACING = 100;
export const LP_FEE = 0;

export type PoolKeyView = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export function poolKeyFor(token: string, stock: string, hook: Address): PoolKeyView {
  const t = token.toLowerCase() as Address;
  const s = stock.toLowerCase() as Address;
  const tokenFirst = t < s;
  return {
    currency0: tokenFirst ? t : s,
    currency1: tokenFirst ? s : t,
    fee: LP_FEE,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  };
}

const poolIdParameters = parseAbiParameters('address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks');

/** Uniswap v4 PoolIdLibrary: keccak256(abi.encode(poolKey)). */
export function poolIdFor(key: PoolKeyView): Hex {
  return keccak256(encodeAbiParameters(poolIdParameters, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

export type QuoteRequest = { token: string; side: 'buy' | 'sell'; amountIn: bigint };

export type QuoteResult = {
  amountIn: string;
  amountOut: string;
  side: 'buy' | 'sell';
  feeBps: number;
  /** Mid price before the swap, whole stock per whole token. */
  midPrice: number | null;
  /** Effective price of this swap, whole stock per whole token. */
  executionPrice: number | null;
  priceImpactPercent: number | null;
  poolKey: PoolKeyView;
  zeroForOne: boolean;
  gasEstimate: string;
  liquidity: string;
};

export class QuoteError extends Error {
  constructor(
    readonly code: 'TOKEN_NOT_FOUND' | 'NOT_CONFIGURED' | 'QUOTE_FAILED' | 'NO_LIQUIDITY',
    message: string,
  ) {
    super(message);
  }
}

export async function quoteExactIn(db: Db, request: QuoteRequest): Promise<QuoteResult> {
  const deployments = serverDeployments();
  if (deployments.length === 0) throw new QuoteError('NOT_CONFIGURED', 'Contracts are not configured.');
  const market = await readMarket(db, request.token);
  // The indexer waits for confirmations. A launched token can still trade in that interval:
  // read its factory and pool directly, then ask the same live quoter as an indexed token.
  const launch = market ? null : await cached('onchain:' + request.token.toLowerCase(), 1_000, () => readLaunchOnchain(request.token as Address));
  if (!market && !launch) throw new QuoteError('TOKEN_NOT_FOUND', 'Unknown token.');
  const hook = market ? hookOf(deployments, market) : launch!.hook;
  if (!hook) throw new QuoteError('NOT_CONFIGURED', 'Contracts are not configured.');
  const stock = market?.stock ?? launch!.stock;
  const key = poolKeyFor(request.token, stock, hook);
  const client = getPublicClient();
  if (launch) {
    const factoryKey = await client.readContract({
      address: launch.factory,
      abi: stockPairFactoryAbi,
      functionName: 'poolKeyOf',
      args: [request.token as Address],
    });
    if (
      factoryKey.currency0.toLowerCase() !== key.currency0 ||
      factoryKey.currency1.toLowerCase() !== key.currency1 ||
      factoryKey.hooks.toLowerCase() !== key.hooks.toLowerCase() ||
      factoryKey.fee !== key.fee ||
      factoryKey.tickSpacing !== key.tickSpacing
    ) throw new QuoteError('NOT_CONFIGURED', 'The launched pool key does not match this deployment.');
  }
  const tokenIsCurrency0 = market?.token_is_currency0 ?? key.currency0 === request.token.toLowerCase();
  // buy = stock in, token out. zeroForOne means currency0 in.
  const zeroForOne = request.side === 'buy' ? !tokenIsCurrency0 : tokenIsCurrency0;
  const poolId = market ? market.pool_id as Hex : poolIdFor(key);

  const [slot0, liquidity, feeBps] = await Promise.all([
    client.readContract({ address: BASE_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }),
    client.readContract({ address: BASE_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId] }),
    client.readContract({ address: hook, abi: stockPairHookAbi, functionName: 'currentFeeBps', args: [poolId] }),
  ]);

  let amountOut: bigint;
  let gasEstimate: bigint;
  try {
    const simulation = await client.simulateContract({
      address: BASE_CONTRACTS.quoter,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: request.amountIn, hookData: '0x' }],
    });
    [amountOut, gasEstimate] = simulation.result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // PartialFill (0xd964f528) is the hook refusing a swap the pool cannot fill in full.
    if (/liquidity|SPL|PriceLimit|PartialFill|d964f528/iu.test(message)) {
      throw new QuoteError('NO_LIQUIDITY', 'Not enough liquidity for this size.');
    }
    throw new QuoteError('QUOTE_FAILED', 'The pool could not quote this swap.');
  }
  if (amountOut === 0n) throw new QuoteError('NO_LIQUIDITY', 'Not enough liquidity for this size.');

  const stockDecimals = market ? Number(market.stock_decimals) : findStock(stock)?.decimals;
  if (stockDecimals === undefined) throw new QuoteError('NOT_CONFIGURED', 'This stock is not configured.');
  const midPrice = e30ToNumber(stockPerTokenE30(slot0[0], tokenIsCurrency0, stockDecimals));
  const amountInWhole = Number(request.amountIn) / 10 ** (request.side === 'buy' ? stockDecimals : 18);
  const amountOutWhole = Number(amountOut) / 10 ** (request.side === 'buy' ? 18 : stockDecimals);
  // Net the hook's fee out before deriving the execution price, so "price impact" measures how far
  // this order moves the pool -- which is what the review sheet says it measures. Dividing the gross
  // input by the net output folded the 1% fee into the number, double-counting a cost the row below
  // it already shows and tripping the 5% warning about a percentage point early.
  const feeFraction = Number(feeBps) / 10_000;
  const netInWhole = request.side === 'buy' ? amountInWhole * (1 - feeFraction) : amountInWhole;
  const netOutWhole = request.side === 'buy' ? amountOutWhole : amountOutWhole / (1 - feeFraction);
  const executionPrice =
    request.side === 'buy' ? netInWhole / amountOutWhole : netOutWhole / amountInWhole;
  const impact = midPrice > 0 && Number.isFinite(executionPrice)
    ? request.side === 'buy'
      ? ((executionPrice - midPrice) / midPrice) * 100
      : ((midPrice - executionPrice) / midPrice) * 100
    : null;

  return {
    amountIn: request.amountIn.toString(),
    amountOut: amountOut.toString(),
    side: request.side,
    feeBps: Number(feeBps),
    midPrice: midPrice > 0 ? midPrice : null,
    executionPrice: Number.isFinite(executionPrice) ? executionPrice : null,
    priceImpactPercent: impact,
    poolKey: key,
    zeroForOne,
    gasEstimate: gasEstimate.toString(),
    liquidity: liquidity.toString(),
  };
}
