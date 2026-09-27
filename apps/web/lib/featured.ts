import type { MarketView } from './market-view';

const isFeatured = (market: Pick<MarketView, 'token'>, featured: string) => market.token.toLowerCase() === featured.toLowerCase();

/** The featured token first, everything else in the order it came. */
export function featuredFirst<T extends Pick<MarketView, 'token'>>(markets: readonly T[], featured: string): T[] {
  return [...markets.filter((m) => isFeatured(m, featured)), ...markets.filter((m) => !isFeatured(m, featured))];
}

/** Everything but the featured token, which has its own card and should not be listed twice. */
export function withoutFeatured<T extends Pick<MarketView, 'token'>>(markets: readonly T[], featured: string): T[] {
  return markets.filter((m) => !isFeatured(m, featured));
}

/** The featured token's market from a list, or the one read on the server when the list lacks it. */
export function pickFeatured<T extends Pick<MarketView, 'token'>>(markets: readonly T[], featured: string, fallback?: T | null): T | null {
  return markets.find((m) => isFeatured(m, featured)) ?? fallback ?? null;
}
