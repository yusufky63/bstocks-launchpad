import type { MarketView } from './types';

/** The screens on the markets board. */
export type Screen = 'all' | 'new' | 'trending' | 'gainers' | 'losers' | 'active';

export const SCREENS: Array<{ value: Screen; label: string; hint: string }> = [
  { value: 'all', label: 'All', hint: 'Most traded first' },
  { value: 'new', label: 'New', hint: 'Launched in the last 24 hours' },
  { value: 'trending', label: 'Trending', hint: 'Highest 24h volume' },
  { value: 'gainers', label: 'Gainers', hint: 'Best 24h change, traded in the last day' },
  { value: 'losers', label: 'Losers', hint: 'Worst 24h change, traded in the last day' },
  { value: 'active', label: 'Traded 24h', hint: 'At least one swap in the last day' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The screener rule, shared by the list and the counts so they never disagree. */
export function applyScreen(rows: MarketView[], screen: Screen, now = Date.now()): MarketView[] {
  switch (screen) {
    case 'new':
      return rows.filter((m) => now - new Date(m.launchedAt).getTime() < DAY_MS);
    case 'trending':
      return [...rows].filter((m) => m.trades24h > 0).sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
    case 'gainers':
      return [...rows].filter((m) => m.trades24h > 0 && (m.change24hPercent ?? 0) > 0).sort((a, b) => (b.change24hPercent ?? 0) - (a.change24hPercent ?? 0));
    case 'losers':
      return [...rows].filter((m) => m.trades24h > 0 && (m.change24hPercent ?? 0) < 0).sort((a, b) => (a.change24hPercent ?? 0) - (b.change24hPercent ?? 0));
    case 'active':
      return rows.filter((m) => m.trades24h > 0);
    default:
      // The default board leads with what is actually being traded. Ordering by launch time put
      // whatever was created last on top, which on a young launchpad is usually a token nobody has
      // touched; "New" already covers that view.
      return [...rows].sort(
        (a, b) =>
          (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) ||
          b.trades24h - a.trades24h ||
          b.holders - a.holders ||
          new Date(b.launchedAt).getTime() - new Date(a.launchedAt).getTime(),
      );
  }
}
