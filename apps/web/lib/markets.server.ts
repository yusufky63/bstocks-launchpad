import 'server-only';

import { listMarkets } from '@stockpair/core/db';

import { cached, TTL } from './cache.server';
import { getDb } from './db.server';
import { toMarketView } from './market-view';
import type { MarketsResponse } from './types';

/** The /api/markets payload for the common list shapes, memoised for a few seconds. */
export async function readMarketsResponse(options: { stock?: string; limit?: number } = {}): Promise<MarketsResponse> {
  const limit = options.limit ?? 100;
  return cached(`markets:${options.stock ?? ''}::${limit}:0`, TTL.list, async () => {
    const db = await getDb();
    const now = new Date();
    const rows = await listMarkets(db, { ...(options.stock ? { stock: options.stock } : {}), limit });
    return { markets: rows.map((row) => toMarketView(row, now)), asOf: now.toISOString() };
  });
}
