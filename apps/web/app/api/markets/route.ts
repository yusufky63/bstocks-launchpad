import { z } from 'zod';

import { listMarkets, readCursor } from '@stockpair/core/db';

import { error, json, limitSchema, parseAddressParam } from '@/lib/api.server';
import { cached, TTL } from '@/lib/cache.server';
import { getDb } from '@/lib/db.server';
import { toMarketView } from '@/lib/market-view';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  stock: z.string().optional(),
  creator: z.string().optional(),
  q: z.string().max(64).optional(),
  limit: limitSchema,
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  orderBy: z.enum(['newest', 'volume24h']).default('newest'),
});

export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');
  const { stock, creator, q, limit, offset, orderBy } = parsed.data;
  const stockAddress = stock ? parseAddressParam(stock) : null;
  if (stock && !stockAddress) return error(400, 'INVALID_STOCK', 'stock must be an address.');
  const creatorAddress = creator ? parseAddressParam(creator) : null;
  if (creator && !creatorAddress) return error(400, 'INVALID_CREATOR', 'creator must be an address.');

  const db = await getDb();
  const rows = await cached(`markets:${stockAddress ?? ''}:${creatorAddress ?? ''}:${q ?? ''}:${limit}:${offset}:${orderBy}`, TTL.list, () =>
    listMarkets(db, {
      ...(stockAddress ? { stock: stockAddress } : {}),
      ...(creatorAddress ? { creator: creatorAddress } : {}),
      ...(q ? { search: q } : {}),
      limit,
      offset,
      orderBy,
    }),
  );
  // Same rule as the server reader: asOf is the indexer's progress, not this response's clock.
  const cursor = await readCursor(db);
  const now = new Date();
  return json({ markets: rows.map((row) => toMarketView(row, now)), asOf: cursor ? new Date(cursor.updated_at).toISOString() : now.toISOString() });
}
