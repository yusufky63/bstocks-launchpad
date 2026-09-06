import { z } from 'zod';

import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { QuoteError, quoteExactIn } from '@/lib/quote.server';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  token: z.string(),
  side: z.enum(['buy', 'sell']),
  amountIn: z.string().regex(/^[1-9]\d{0,38}$/u),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, 'INVALID_JSON', 'Body must be JSON.');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return error(400, 'INVALID_BODY', 'token, side and amountIn are required.');
  const token = parseAddressParam(parsed.data.token);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');

  try {
    const db = await getDb();
    const quote = await quoteExactIn(db, { token, side: parsed.data.side, amountIn: BigInt(parsed.data.amountIn) });
    return json(quote);
  } catch (cause) {
    if (cause instanceof QuoteError) {
      const status = cause.code === 'TOKEN_NOT_FOUND' ? 404 : cause.code === 'NOT_CONFIGURED' ? 503 : 409;
      return error(status, cause.code, cause.message);
    }
    return error(502, 'QUOTE_FAILED', 'The pool could not quote this swap.');
  }
}
