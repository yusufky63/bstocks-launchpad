import type { Address } from 'viem';

import { SUPPLY_RAW } from './math';

/**
 * Exact replay of the creator's buy inside `launchAndBuy`: an exact-input stock -> token swap on the
 * pool the factory has just seeded. There is no onchain view for this (the factory has no size left
 * for one), so the quote the creator signs against is computed here, in bigint, to the wei.
 *
 * Inputs are what the web reads before a launch: `factory.previewOpening(stock, predictedToken)`
 * gives the opening tick, and the address order of token and stock gives the currency order.
 * Every step mirrors v4-core (TickMath, SqrtPriceMath, SwapMath, the bitmap walk) and the factory's
 * own range and liquidity code; the forge vectors in packages/contracts/test/vectors pin it.
 */

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_TICK = 887_272;
const TICK_SPACING = 100;
/** The factory's range edge: the largest usable tick for a spacing of 100. */
const MAX_USABLE_TICK = 887_200;
/** The hook's fee on the stock side and the creator's share of it (StockPairHook constants). */
const HOOK_FEE_BPS = 100n;
const CREATOR_SHARE_BPS = 7_000n;
const BPS = 10_000n;

/** v4-core TickMath ratios for bits 1..19 of |tick|, in the same order as getSqrtPriceAtTick. */
const TICK_FACTORS: readonly (readonly [number, bigint])[] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** The factory's rule (`token < stock`): the launched token is currency0 when its address sorts first. */
export function tokenIsCurrency0(token: Address, stock: Address): boolean {
  return BigInt(token) < BigInt(stock);
}

/** v4-core TickMath.getSqrtPriceAtTick, bit for bit. Throws outside [-887272, 887272]. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || Math.abs(tick) > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`);
  const abs = Math.abs(tick);
  let price = abs & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of TICK_FACTORS) {
    if (abs & bit) price = (price * factor) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;
  // Round up to Q64.96, as the contract does.
  return (price + (1n << 32n) - 1n) >> 32n;
}

const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);
/** Solidity's floor(x / 100) for ticks, which rounds toward -infinity like TickBitmap.compress. */
const compress = (tick: number): number => Math.floor(tick / TICK_SPACING);

// SqrtPriceMath.getAmount0Delta / getAmount1Delta for a <= b. bigint is exact, as FullMath is.
const amount0Down = (a: bigint, b: bigint, L: bigint): bigint => ((L << 96n) * (b - a)) / b / a;
const amount0Up = (a: bigint, b: bigint, L: bigint): bigint => ceilDiv(ceilDiv((L << 96n) * (b - a), b), a);
const amount1Down = (a: bigint, b: bigint, L: bigint): bigint => (L * (b - a)) / Q96;
const amount1Up = (a: bigint, b: bigint, L: bigint): bigint => ceilDiv(L * (b - a), Q96);

/** SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp(add = true), including its overflow branch. */
function nextFromAmount0Add(s: bigint, L: bigint, A: bigint): bigint {
  const numerator = L << 96n;
  const product = A * s;
  if (product <= MAX_UINT256) {
    const denominator = numerator + product;
    if (denominator <= MAX_UINT256) return ceilDiv(numerator * s, denominator);
  }
  return ceilDiv(numerator, numerator / s + A);
}

/** The factory's `_launchRange` and the liquidity it seeds with the whole supply. */
export function launchRange(
  tokenIsCurrency0: boolean,
  openingTick: number,
): { tickLower: number; tickUpper: number; liquidity: bigint } {
  if (!Number.isSafeInteger(openingTick)) throw new RangeError(`tick out of range: ${openingTick}`);
  const floored = compress(openingTick) * TICK_SPACING;
  const [tickLower, tickUpper] = tokenIsCurrency0
    ? [floored + TICK_SPACING, MAX_USABLE_TICK]
    : [-MAX_USABLE_TICK, floored];
  if (tickLower >= tickUpper) throw new RangeError('invalid launch range');
  const sa = sqrtPriceAtTick(tickLower);
  const sb = sqrtPriceAtTick(tickUpper);
  // LiquidityAmounts.getLiquidityForAmount0 / getLiquidityForAmount1.
  const liquidity = tokenIsCurrency0 ? (SUPPLY_RAW * ((sa * sb) / Q96)) / (sb - sa) : (SUPPLY_RAW * Q96) / (sb - sa);
  return { tickLower, tickUpper, liquidity };
}

export interface LaunchBuyQuote {
  /** Launched tokens (raw, 18 decimals) the creator receives. */
  tokensOut: bigint;
  /** The hook's 1% fee on `stockIn`, in raw stock. */
  fee: bigint;
  /** The part of `fee` booked back to the creator as claimable (the hook's 70%). */
  creatorFeeBack: bigint;
  /** Share of the fixed supply bought, floored: basis points for rules, parts per million for display. */
  supplyBps: bigint;
  supplyPpm: bigint;
  /** The pool price once the buy is done. */
  sqrtPriceAfterX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/**
 * Tokens the creator receives for `stockIn` raw stock in the launch transaction. Nothing can trade
 * the pool before this buy, so the opening tick is the whole state. Throws on a non-positive amount
 * and when the buy would exhaust the position (the hook's partial-fill guard would revert it).
 */
export function quoteLaunchBuy(a: { openingTick: number; tokenIsCurrency0: boolean; stockIn: bigint }): LaunchBuyQuote {
  if (a.stockIn <= 0n) throw new RangeError('stockIn must be positive');
  const { tickLower, tickUpper, liquidity: L } = launchRange(a.tokenIsCurrency0, a.openingTick);
  const fee = (a.stockIn * HOOK_FEE_BPS) / BPS;
  let A = a.stockIn - fee;
  let out = 0n;
  let s: bigint;

  if (a.tokenIsCurrency0) {
    // Stock is currency1 and the price rises. The pool opens below the range, and crossing that
    // empty gap costs nothing, so the walk starts at the range's lower edge.
    let t = tickLower;
    s = sqrtPriceAtTick(tickLower);
    for (;;) {
      const c = compress(t) + 1;
      const wordEnd = (Math.floor(c / 256) * 256 + 255) * TICK_SPACING;
      const next = Math.min(wordEnd, tickUpper);
      const sT = sqrtPriceAtTick(next);
      const inMax = amount1Up(s, sT, L);
      if (A >= inMax) {
        out += amount0Down(s, sT, L);
        A -= inMax;
        s = sT;
        t = next;
        if (A === 0n) break;
        if (next === tickUpper) throw new RangeError('the buy would exhaust the launch position');
      } else {
        const s1 = s + (A << 96n) / L;
        out += amount0Down(s, s1, L);
        s = s1;
        break;
      }
    }
  } else {
    // Stock is currency0 and the price falls from the range's upper edge.
    s = sqrtPriceAtTick(tickUpper);
    let t = tickUpper - 1;
    for (;;) {
      const wordStart = Math.floor(compress(t) / 256) * 256 * TICK_SPACING;
      const next = Math.max(wordStart, tickLower);
      const sT = sqrtPriceAtTick(next);
      const inMax = amount0Up(sT, s, L);
      if (A >= inMax) {
        out += amount1Down(sT, s, L);
        A -= inMax;
        s = sT;
        t = next - 1;
        if (A === 0n) break;
        if (next === tickLower) throw new RangeError('the buy would exhaust the launch position');
      } else {
        const s1 = nextFromAmount0Add(s, L, A);
        out += amount1Down(s1, s, L);
        s = s1;
        break;
      }
    }
  }

  return {
    tokensOut: out,
    fee,
    creatorFeeBack: (fee * CREATOR_SHARE_BPS) / BPS,
    supplyBps: (out * BPS) / SUPPLY_RAW,
    supplyPpm: (out * 1_000_000n) / SUPPLY_RAW,
    sqrtPriceAfterX96: s,
    tickLower,
    tickUpper,
    liquidity: L,
  };
}
