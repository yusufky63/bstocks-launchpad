import { createPendingStore, pendingKey, type Pending } from './pending-store';
import type { BurnSummary, BurnView, MarketView } from './types';

/**
 * This browser's own burns, read from their receipt the moment the wallet reports them mined, and
 * shown until the indexer has stored them: the same reason and the same rules as pending trades.
 */
export type PendingBurn = Pending<BurnView>;

const store = createPendingStore<BurnView>();

export const addPendingBurns = (token: string, burns: readonly BurnView[], now?: number) => store.add(token, burns, now);
export const markBurnsIndexed = (token: string, indexed: readonly BurnView[], now?: number) => store.markIndexed(token, indexed, now);
export const pendingBurns = (token: string) => store.list(token);
export const usePendingBurns = (token: string) => store.use(token);

const newestFirst = (a: BurnView, b: BurnView) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || b.logIndex - a.logIndex;

/** Pending burns a block-stamped total does not include yet: the ones after its newest burn. */
function notCounted(pending: readonly PendingBurn[], lastBurnBlock: string | null): PendingBurn[] {
  return pending.filter((p) => lastBurnBlock === null || BigInt(p.blockNumber) > BigInt(lastBurnBlock));
}

/** Rows the indexed list does not hold yet, newest first and marked pending, ahead of it. */
export function withPendingBurns(indexed: readonly BurnView[], pending: readonly PendingBurn[]): BurnView[] {
  if (pending.length === 0) return indexed as BurnView[];
  const seen = new Set(indexed.map(pendingKey));
  const extra = pending
    .filter((p) => !seen.has(pendingKey(p)))
    .sort(newestFirst)
    .map((p): BurnView => ({ ...p, pending: true }));
  return extra.length === 0 ? (indexed as BurnView[]) : [...extra, ...indexed];
}

/**
 * Totals with the pending burns added. Burners and the leaderboard are left to the indexer: whether
 * this wallet burned before is not something the receipt can say.
 */
export function withPendingBurnSummary(summary: BurnSummary, pending: readonly PendingBurn[]): BurnSummary {
  const extra = notCounted(pending, summary.lastBurnBlock);
  if (extra.length === 0) return summary;
  const raw = extra.reduce((sum, p) => sum + BigInt(p.amountRaw), BigInt(summary.burnedRaw));
  const newest = extra.slice().sort(newestFirst)[0]!;
  return {
    ...summary,
    burned: summary.burned + extra.reduce((sum, p) => sum + p.amount, 0),
    burnedRaw: raw.toString(),
    supplyPercent: summary.supplyPercent + extra.reduce((sum, p) => sum + p.supplyPercent, 0),
    burns: summary.burns + extra.length,
    lastBurnAt: newest.blockTime,
    lastBurnBlock: newest.blockNumber,
  };
}

type BurnFigures = Pick<MarketView, 'burned' | 'burnedPercent' | 'burns' | 'lastBurnBlock'>;

/** The market's burn figures with this browser's burns the market row does not include yet. */
export function withPendingBurnMarket<M extends BurnFigures>(market: M, pending: readonly PendingBurn[]): M {
  const extra = notCounted(pending, market.lastBurnBlock);
  if (extra.length === 0) return market;
  const newest = extra.slice().sort(newestFirst)[0]!;
  return {
    ...market,
    burned: market.burned + extra.reduce((sum, p) => sum + p.amount, 0),
    burnedPercent: market.burnedPercent + extra.reduce((sum, p) => sum + p.supplyPercent, 0),
    burns: market.burns + extra.length,
    lastBurnBlock: newest.blockNumber,
  };
}
