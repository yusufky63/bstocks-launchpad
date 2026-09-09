import 'server-only';

import { listMarkets, readCursor} from '@stockpair/core/db';

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
      // asOf is when the data was last *true*, not when this response was built. Stamping it with
      // the server clock made the board say "Live · updated just now" over prices the indexer had
      // stopped advancing — and after a day of that, every token reads a confident 0.00%.
      const [rows, cursor] = await Promise.all([
        listMarkets(db, { ...(options.stock ? { stock: options.stock } : {}), limit }),
        readCursor(db),
      ]);
      const asOf = cursor ? new Date(cursor.updated_at).toISOString() : now.toISOString();
      return { markets: rows.map((row) => toMarketView(row, now)), asOf };
    }),
    RENDER_BUDGET_MS,
    null,
  );
}
