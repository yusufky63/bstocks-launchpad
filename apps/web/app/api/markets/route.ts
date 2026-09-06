import { z } from 'zod';

import { listMarkets } from '@stockpair/core/db';

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
});

export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');
  const { stock, creator, q, limit, offset } = parsed.data;
  const stockAddress = stock ? parseAddressParam(stock) : null;
  if (stock && !stockAddress) return error(400, 'INVALID_STOCK', 'stock must be an address.');
  const creatorAddress = creator ? parseAddressParam(creator) : null;
  if (creator && !creatorAddress) return error(400, 'INVALID_CREATOR', 'creator must be an address.');

  const db = await getDb();
  const rows = await cached(`markets:${stockAddress ?? ''}:${creatorAddress ?? ''}:${q ?? ''}:${limit}:${offset}`, TTL.list, () =>
    listMarkets(db, {
      ...(stockAddress ? { stock: stockAddress } : {}),
      ...(creatorAddress ? { creator: creatorAddress } : {}),
      ...(q ? { search: q } : {}),
      limit,
      offset,
    }),
  );
  const now = new Date();
  return json({ markets: rows.map((row) => toMarketView(row, now)), asOf: now.toISOString() });
}
