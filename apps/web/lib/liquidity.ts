const Q96 = 2 ** 96;

/** sqrt(1.0001^tick) as a plain number; precise enough for display, never for settlement. */
export function sqrtRatioAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * Token amounts held by a concentrated-liquidity position at the current price. The launch position
 * is the only liquidity in a StockPair pool and it never changes, so these are the pool's reserves.
 * Amounts are in raw units (wei for the token, 1e-8 for a stock).
 */
export function positionAmounts(input: { sqrtPriceX96: bigint; tickLower: number; tickUpper: number; liquidity: bigint }): { amount0: number; amount1: number } {
  const sqrtP = Number(input.sqrtPriceX96) / Q96;
  const sqrtA = sqrtRatioAtTick(input.tickLower);
  const sqrtB = sqrtRatioAtTick(input.tickUpper);
  const L = Number(input.liquidity);
  if (sqrtP <= sqrtA) return { amount0: (L * (sqrtB - sqrtA)) / (sqrtA * sqrtB), amount1: 0 };
  if (sqrtP >= sqrtB) return { amount0: 0, amount1: L * (sqrtB - sqrtA) };
  return { amount0: (L * (sqrtB - sqrtP)) / (sqrtP * sqrtB), amount1: L * (sqrtP - sqrtA) };
}

export type PoolReserves = {
  /** Whole tokens still in the pool. */
  token: number;
  /** Whole stock units in the pool. */
  stock: number;
  /** Share of the fixed supply still held by the pool, 0..1. */
  tokenShareOfSupply: number;
};

/** Reserves of a launch pool, oriented by which side the token is on. */
export function poolReserves(input: { sqrtPriceX96: bigint; tickLower: number; tickUpper: number; liquidity: bigint; tokenIsCurrency0: boolean; stockDecimals: number }): PoolReserves {
  const { amount0, amount1 } = positionAmounts(input);
  const tokenRaw = input.tokenIsCurrency0 ? amount0 : amount1;
  const stockRaw = input.tokenIsCurrency0 ? amount1 : amount0;
  const token = tokenRaw / 1e18;
  return { token, stock: stockRaw / 10 ** input.stockDecimals, tokenShareOfSupply: Math.min(1, Math.max(0, token / 1_000_000_000)) };
}
