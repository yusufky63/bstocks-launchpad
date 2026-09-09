import 'server-only';

import { parseAbi, type Address, type Hex } from 'viem';

import { BASE_CONTRACTS, stockPairHookAbi, stockPerTokenE30, e30ToNumber } from '@stockpair/core';
import { readMarket, type Db } from '@stockpair/core/db';

import { getPublicClient, serverDeployment } from './chain.server';

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
  const deployment = serverDeployment();
  if (!deployment) throw new QuoteError('NOT_CONFIGURED', 'Contracts are not configured.');
  const market = await readMarket(db, request.token);
  if (!market) throw new QuoteError('TOKEN_NOT_FOUND', 'Unknown token.');

  const key = poolKeyFor(market.token, market.stock, deployment.hook);
  const tokenIsCurrency0 = market.token_is_currency0;
  // buy = stock in, token out. zeroForOne means currency0 in.
  const zeroForOne = request.side === 'buy' ? !tokenIsCurrency0 : tokenIsCurrency0;
  const client = getPublicClient();
  const poolId = market.pool_id as Hex;

  const [slot0, liquidity, feeBps] = await Promise.all([
    client.readContract({ address: BASE_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }),
    client.readContract({ address: BASE_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId] }),
    client.readContract({ address: deployment.hook, abi: stockPairHookAbi, functionName: 'currentFeeBps', args: [poolId] }),
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
    if (/liquidity|SPL|PriceLimit/iu.test(message)) {
      throw new QuoteError('NO_LIQUIDITY', 'Not enough liquidity for this size.');
    }
    throw new QuoteError('QUOTE_FAILED', 'The pool could not quote this swap.');
  }
  if (amountOut === 0n) throw new QuoteError('NO_LIQUIDITY', 'Not enough liquidity for this size.');

  const stockDecimals = Number(market.stock_decimals);
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
