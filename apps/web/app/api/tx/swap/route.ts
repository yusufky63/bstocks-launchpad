import { z } from 'zod';

import { addressSchema as address, error, json, serializable } from '@/lib/api.server';
import { BUILDER_CODE } from '@/lib/attribution';
import { getDb } from '@/lib/db.server';
import { SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from '@/lib/limits';
import { QuoteError } from '@/lib/quote.server';
import { limitCaller } from '@/lib/rate-limit.server';
import { TxError, buildSwapTx } from '@/lib/tx.server';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  token: address,
  side: z.enum(['buy', 'sell']),
  amountIn: z.string().regex(/^[1-9]\d{0,38}$/u),
  account: address,
  recipient: address.optional(),
  slippageBps: z.number().int().min(SLIPPAGE_MIN_BPS).max(SLIPPAGE_MAX_BPS).optional(),
  builderCode: z.string().regex(BUILDER_CODE).optional(),
});

/**
 * The approve (when the allowance is short) and swap calls for one exact-input trade, ready for the
 * account's wallet: the same minimum output, deadline and router this site's trade panel uses.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = limitCaller(request, 'tx');
  if (limited) return limited;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, 'INVALID_JSON', 'Body must be JSON.');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return error(400, 'INVALID_BODY', 'token, side, amountIn and account are required; slippageBps is 10 to 500.');
  const { amountIn, ...rest } = parsed.data;
  try {
    const tx = await buildSwapTx(await getDb(), { ...rest, amountIn: BigInt(amountIn) });
    return json(serializable(tx));
  } catch (cause) {
    if (cause instanceof TxError) return json({ error: { code: cause.code, message: cause.message, ...(cause.details ? { details: cause.details } : {}) } }, cause.status);
    if (cause instanceof QuoteError) {
      const status = cause.code === 'TOKEN_NOT_FOUND' ? 404 : cause.code === 'NOT_CONFIGURED' ? 503 : 409;
      return error(status, cause.code, cause.message);
    }
    return error(502, 'TX_FAILED', 'The swap could not be built right now.');
  }
}
