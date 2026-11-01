import { useSyncExternalStore } from 'react';

/**
 * Rows this browser read from its own transaction receipts, kept per token until the indexer has
 * stored the same transaction and log. In memory, per page load: a reload drops them and the
 * indexed data is all there is.
 */

type Keyed = { txHash: string; logIndex: number };

export type Pending<T> = T & {
  token: string;
  recordedAt: number;
  /** When the indexed list first held this row; null until then. */
  indexedAt: number | null;
};

/** After the indexed list holds a row, how long other views get to refetch before it is dropped. */
export const KEEP_AFTER_INDEXED_MS = 30_000;
/** A row the indexer never stores (a reorg, or the indexer is down) stops showing after this. */
export const GIVE_UP_MS = 180_000;

export const pendingKey = (row: Keyed) => `${row.txHash.toLowerCase()}:${row.logIndex}`;

export type PendingStore<T extends Keyed> = {
  add(token: string, rows: readonly T[], now?: number): void;
  /** Notes which pending rows the indexed list now holds, and drops the ones that are done. */
  markIndexed(token: string, indexed: readonly Keyed[], now?: number): void;
  list(token: string): readonly Pending<T>[];
  use(token: string): readonly Pending<T>[];
};

export function createPendingStore<T extends Keyed>(): PendingStore<T> {
  const empty: readonly Pending<T>[] = Object.freeze([]);
  const byToken = new Map<string, readonly Pending<T>[]>();
  const listeners = new Set<() => void>();

  const prune = (rows: readonly Pending<T>[], now: number) => {
    const kept = rows.filter((p) => (p.indexedAt === null ? now - p.recordedAt < GIVE_UP_MS : now - p.indexedAt < KEEP_AFTER_INDEXED_MS));
    return kept.length === rows.length ? rows : kept;
  };
  const put = (token: string, next: readonly Pending<T>[], previous: readonly Pending<T>[]) => {
    if (next === previous) return;
    if (next.length === 0) byToken.delete(token);
    else byToken.set(token, next);
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const list = (token: string) => byToken.get(token.toLowerCase()) ?? empty;

  return {
    add(token, rows, now = Date.now()) {
      const id = token.toLowerCase();
      const previous = byToken.get(id) ?? empty;
      const known = new Set(previous.map(pendingKey));
      const added = rows.filter((r) => !known.has(pendingKey(r))).map((r) => ({ ...r, token: id, recordedAt: now, indexedAt: null }));
      put(id, prune(added.length === 0 ? previous : [...previous, ...added], now), previous);
    },
    markIndexed(token, indexed, now = Date.now()) {
      const id = token.toLowerCase();
      const previous = byToken.get(id);
      if (!previous) return;
      const seen = new Set(indexed.map(pendingKey));
      let changed = false;
      const marked = previous.map((p) => {
        if (p.indexedAt !== null || !seen.has(pendingKey(p))) return p;
        changed = true;
        return { ...p, indexedAt: now };
      });
      put(id, prune(changed ? marked : previous, now), previous);
    },
    list,
    use(token) {
      return useSyncExternalStore(subscribe, () => list(token), () => empty);
    },
  };
}
