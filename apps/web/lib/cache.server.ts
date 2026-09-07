import 'server-only';

type Entry<T> = { value: T; expiresAt: number };

const store = (globalThis as typeof globalThis & { __stockpairCache?: Map<string, Entry<unknown>> }).__stockpairCache ?? new Map<string, Entry<unknown>>();
(globalThis as typeof globalThis & { __stockpairCache?: Map<string, Entry<unknown>> }).__stockpairCache = store;
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Short-lived server memo. The indexer writes every few seconds, so a page rendered from a value a
 * few seconds old is still a page rendered from confirmed chain data; what it saves is a round trip
 * to the database (or an RPC) for every visitor in that window. Concurrent callers share one fetch.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const task = load()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      if (store.size > 5_000) sweep();
      return value;
    })
    .finally(() => {
      // Only retract this task; a newer one may already have taken the key.
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
  inFlight.set(key, task);
  // A load that never settles would otherwise be handed to every later caller for the life of the
  // process, so one stalled query poisons its key permanently and every request on it times out.
  // Stop sharing it after the deadline; the next caller starts a fresh attempt, and if this one
  // does finish it still fills the cache.
  const retract = setTimeout(() => {
    if (inFlight.get(key) === task) inFlight.delete(key);
  }, STALE_LOAD_MS);
  retract.unref?.();
  return task;
}

/** Drops cached values whose key starts with `prefix` (or everything when omitted). */
export function invalidate(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);
}

/**
 * Resolves with the fallback if the promise has not settled within ms. A serverless render must
 * never hang on a slow database read: it returns an empty shell and the client polls to fill in.
 * The underlying promise keeps running and still populates the cache for the next request.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    promise.then(finish, () => finish(fallback));
  });
}

/** How long a server component may wait for initial data before rendering an empty shell. */
export const RENDER_BUDGET_MS = 7_000;

/**
 * How long an API route may wait. It is larger than the render budget on purpose: a page render
 * blocks what the visitor sees, while an API call is a background poll whose client keeps showing
 * the last good data. The database is in another region, so a cold serverless instance pays a TLS
 * handshake plus a round trip per query before any work happens, and cutting that off at the render
 * budget turns a slow answer into no answer.
 */
export const API_BUDGET_MS = 9_000;

/** After this, an unfinished load stops being shared with new callers. */
const STALE_LOAD_MS = 12_000;

export const TTL = {
  /** Lists that refresh with every indexer tick. */
  list: 5_000,
  /** One token's market row. */
  market: 3_000,
  /** Stock quotes change at most once a minute. */
  stocks: 15_000,
  /** RPC reads (pool state, claimable balances). */
  chain: 10_000,
  /** Heavier aggregates. */
  stats: 15_000,
} as const;
