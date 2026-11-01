import { z } from 'zod';

import { readMarket } from '@stockpair/core/db';

import { error, json, limitSchema, parseAddressParam } from '@/lib/api.server';
import { readTokenBurns } from '@/lib/burns.server';
import { getDb } from '@/lib/db.server';
import { limitCaller } from '@/lib/rate-limit.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

const querySchema = z.object({
  limit: limitSchema,
  before: z.coerce.bigint().optional(),
  beforeLog: z.coerce.number().int().min(0).optional(),
});

/** A token's burns (transfers to 0x…dEaD), newest first; the first page adds the totals and the top burners. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const limited = limitCaller(request, 'token');
  if (limited) return limited;
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');

  const db = await getDb();
  const market = await readMarket(db, token);
  if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No token was launched at this address.');
  const { limit, before, beforeLog } = parsed.data;
  return json(await readTokenBurns(db, token, market.symbol, { limit, ...(before !== undefined ? { before } : {}), ...(beforeLog !== undefined ? { beforeLog } : {}) }));
}
