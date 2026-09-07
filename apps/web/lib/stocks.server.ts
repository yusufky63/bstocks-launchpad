import 'server-only';

import { listStocks } from '@stockpair/core/db';

import { cached, RENDER_BUDGET_MS, TTL, withTimeout } from './cache.server';
import { getDb } from './db.server';
import { feedStatus } from './market-view';
import type { StocksResponse } from './types';

/** The /api/stocks payload, built server-side so pages and the shell can render it on first paint. */
/** Null means the read did not finish in time — never "there are no stocks". */
export async function readStocksResponse(): Promise<StocksResponse | null> {
  return withTimeout(cached('stocks', TTL.stocks, readStocksUncached), RENDER_BUDGET_MS, null);
}

async function readStocksUncached(): Promise<StocksResponse> {
  const db = await getDb();
  const [stocks, counts] = await Promise.all([
    listStocks(db),
    db.query<{ stock: string; launches: string }>('SELECT stock, count(*)::text AS launches FROM launches GROUP BY stock'),
  ]);
  const launchesByStock = new Map(counts.map((c) => [c.stock, Number(c.launches)]));
  return {
    stocks: stocks.map((stock) => ({
      address: stock.address,
      symbol: stock.symbol,
      ticker: stock.ticker,
      name: stock.name,
      decimals: Number(stock.decimals),
      feed: stock.feed,
      enabled: stock.enabled,
      image: stock.image_uri ?? null,
      priceUsd: stock.price_usd8 ? Number(stock.price_usd8) / 1e8 : null,
      feedUpdatedAt: stock.feed_updated_at ? new Date(stock.feed_updated_at).toISOString() : null,
      feedStatus: feedStatus(stock.feed_updated_at ?? null),
      launches: launchesByStock.get(stock.address) ?? 0,
    })),
  };
}
