import { z } from 'zod';

import { listCandles, readMarket } from '@stockpair/core/db';

import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2_000).default(500),
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
  const rows = await listCandles(db, token, parsed.data);
  const stockUnit = 10 ** Number(market.stock_decimals);
  return json({
    token,
    interval: '1m',
    quote: { symbol: market.stock_symbol, usd: market.stock_usd8 === null ? null : Number(market.stock_usd8) / 1e8 },
    candles: rows.map((row) => ({
      time: Math.floor(new Date(row.bucket).getTime() / 1000),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volumeStock: Number(row.volume_stock_raw) / stockUnit,
      volumeToken: Number(row.volume_token_raw) / 1e18,
      trades: Number(row.trade_count),
    })),
  });
}
