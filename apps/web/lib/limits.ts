/**
 * Trade limits the site and the transaction API both apply. Kept out of lib/settings.ts, which is a
 * client module: a server route importing a constant from it would get a client reference instead.
 */

export const DEFAULT_SLIPPAGE_BPS = 100;
/** Trade slippage bounds: 0.1% to 5%. The cap is a safeguard, so a value outside it is refused, never clamped. */
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 500;
/** Amber from here: the review sheet spells out how little the trade may return. */
export const SLIPPAGE_HIGH_BPS = 300;
/** Price impact tiers, in percent: amber from 5, red with a required tick from 25. */
export const IMPACT_WARN_PCT = 5;
export const IMPACT_SEVERE_PCT = 25;

export function isValidSlippageBps(v: number): boolean {
  return Number.isInteger(v) && v >= SLIPPAGE_MIN_BPS && v <= SLIPPAGE_MAX_BPS;
}
