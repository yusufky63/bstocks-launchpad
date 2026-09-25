/**
 * Price math for StockPair pools. All pool prices are Uniswap v4 sqrtPriceX96 values.
 * Launched tokens always have 18 decimals; stocks have `stockDecimals` (8 for Coinbase stocks).
 */

export const TOKEN_DECIMALS = 18;
export const PRICE_SCALE = 30; // decimal places used for stored prices
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const TEN = 10n;

export const SUPPLY_RAW = 1_000_000_000n * 10n ** 18n;
export const SUPPLY_WHOLE = 1_000_000_000n;

/**
 * Whole stock per whole token, scaled by 10^PRICE_SCALE.
 * price (v4) = raw currency1 per raw currency0 = sqrt^2 / 2^192.
 */
export function stockPerTokenE30(
  sqrtPriceX96: bigint,
  tokenIsCurrency0: boolean,
  stockDecimals = 8,
): bigint {
  const scale = TEN ** BigInt(PRICE_SCALE);
  const decimalShift = TEN ** BigInt(TOKEN_DECIMALS - stockDecimals); // 1e10 for 8-dec stocks
  const priceNumerator = sqrtPriceX96 * sqrtPriceX96; // price = numerator / 2^192
  if (tokenIsCurrency0) {
    // raw stock per raw token; whole stock per whole token = price * 10^(18-8)
    return (priceNumerator * decimalShift * scale) / Q192;
  }
  // raw token per raw stock; whole stock per whole token = 10^(18-8) / price
  if (priceNumerator === 0n) return 0n;
  return (Q192 * scale * decimalShift) / priceNumerator;
}

/** Converts a 10^30-scaled price into a decimal string (for numeric(60,30) columns). */
export function e30ToDecimalString(valueE30: bigint): string {
  const negative = valueE30 < 0n;
  const abs = negative ? -valueE30 : valueE30;
  const whole = abs / TEN ** BigInt(PRICE_SCALE);
  const fraction = (abs % TEN ** BigInt(PRICE_SCALE)).toString().padStart(PRICE_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function e30ToNumber(valueE30: bigint): number {
  return Number(valueE30) / 10 ** PRICE_SCALE;
}

/** Token price in USD given whole-stock-per-token (E30) and stock USD price (8 decimals). */
export function tokenUsd(priceStockPerTokenE30: bigint, stockUsd8: bigint): number {
  return (Number(priceStockPerTokenE30) / 10 ** PRICE_SCALE) * (Number(stockUsd8) / 1e8);
}

export function fdvUsd(priceStockPerTokenE30: bigint, stockUsd8: bigint): number {
  return tokenUsd(priceStockPerTokenE30, stockUsd8) * Number(SUPPLY_WHOLE);
}

/**
 * USD per token at the pool's opening price, priced with the Chainlink value the factory read at
 * launch. A launch that buys in the same transaction moves the price at once, so the last trade
 * price overstates where the token opened; this is the figure to announce as "opens at".
 */
export function openingPriceUsd(
  openingSqrtPriceX96: bigint,
  tokenIsCurrency0: boolean,
  stockDecimals: number,
  stockUsd8: bigint,
): number {
  return tokenUsd(stockPerTokenE30(openingSqrtPriceX96, tokenIsCurrency0, stockDecimals), stockUsd8);
}

/** Formats a raw bigint amount with the given decimals into a compact decimal string. */
export function formatAmount(raw: bigint, decimals: number, maxFraction = 4): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = TEN ** BigInt(decimals);
  const whole = abs / unit;
  let fraction = (abs % unit).toString().padStart(decimals, '0').slice(0, maxFraction);
  fraction = fraction.replace(/0+$/u, '');
  const wholeText = whole.toLocaleString('en-US');
  return `${negative ? '-' : ''}${wholeText}${fraction ? `.${fraction}` : ''}`;
}

/** Parses a decimal string typed by a user into a raw bigint; returns null when invalid. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim().replace(/,/gu, '');
  if (!/^\d*(?:\.\d*)?$/u.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  const raw = BigInt(whole || '0') * TEN ** BigInt(decimals) + BigInt((fraction || '0').padEnd(decimals, '0'));
  return raw;
}

/** Percent change between two prices; null when the base is zero. */
export function percentChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function sqrtPriceX96ToTick(sqrtPriceX96: bigint): number {
  const price = Number(sqrtPriceX96) / Number(Q96);
  return Math.floor(Math.log(price * price) / Math.log(1.0001));
}
