import 'server-only';

import { listMarkets } from '@stockpair/core/db';

import { cached, RENDER_BUDGET_MS, TTL, withTimeout } from './cache.server';
import { getDb } from './db.server';
import { toMarketView } from './market-view';
import type { MarketsResponse } from './types';

/** The /api/markets payload for the common list shapes, memoised for a few seconds. */
/** Null means the read did not finish in time — never "there are no tokens". */
export async function readMarketsResponse(options: { stock?: string; limit?: number } = {}): Promise<MarketsResponse | null> {
  const limit = options.limit ?? 100;
  return withTimeout(
    cached(`markets:${options.stock ?? ''}::${limit}:0`, TTL.list, async () => {
      const db = await getDb();
      const now = new Date();
      const rows = await listMarkets(db, { ...(options.stock ? { stock: options.stock } : {}), limit });
      return { markets: rows.map((row) => toMarketView(row, now)), asOf: now.toISOString() };
    }),
    RENDER_BUDGET_MS,
    null,
  );
}
