import { z } from 'zod';

import { isCandleBucket, listCandles, listStockQuoteHistory, readMarket } from '@stockpair/core/db';

import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2_000).default(500),
  /** Bucket width in minutes. One of the widths the chart offers; anything else is refused. */
  bucket: z.coerce.number().int().refine(isCandleBucket, 'unsupported bucket').default(1),
});

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');

  const db = await getDb();
  const market = await readMarket(db, token);
  if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No token was launched at this address.');
  const rows = await listCandles(db, token, { ...parsed.data, bucketMinutes: parsed.data.bucket });
  const stockUnit = 10 ** Number(market.stock_decimals);
  const latestUsd = market.stock_usd8 === null ? null : Number(market.stock_usd8) / 1e8;

  // Each candle carries the stock price that was live when it printed. Pricing old candles with
  // today's quote would redraw settled history every time the stock moves, and would hide the
  // stock's own contribution to a token's dollar price behind a single flat multiplier.
  const first = rows[0] ? new Date(rows[0].bucket) : null;
  const last = rows[rows.length - 1] ? new Date(rows[rows.length - 1]!.bucket) : null;
  const history = first && last ? await listStockQuoteHistory(db, market.stock, first, last) : [];
  let cursor = 0;
  let inEffect: number | null = history.length > 0 ? Number(history[0]!.price_usd8) / 1e8 : latestUsd;

  return json({
    token,
    interval: '1m',
    quote: { symbol: market.stock_symbol, usd: latestUsd },
    candles: rows.map((row) => {
      const at = new Date(row.bucket).getTime();
      while (cursor < history.length && new Date(history[cursor]!.feed_updated_at).getTime() <= at) {
        inEffect = Number(history[cursor]!.price_usd8) / 1e8;
        cursor += 1;
      }
      return {
        time: Math.floor(at / 1000),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volumeStock: Number(row.volume_stock_raw) / stockUnit,
        volumeToken: Number(row.volume_token_raw) / 1e18,
        trades: Number(row.trade_count),
        stockUsd: inEffect,
      };
    }),
  });
}
