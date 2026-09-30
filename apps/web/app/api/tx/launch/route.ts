import { z } from 'zod';

import { addressSchema as address, error, json, serializable } from '@/lib/api.server';
import { BUILDER_CODE } from '@/lib/attribution';
import { DEV_TOLERANCE_DEFAULT_BPS, DEV_TOLERANCE_MAX_BPS, DEV_TOLERANCE_MIN_BPS } from '@/lib/launch';
import { limitCaller } from '@/lib/rate-limit.server';
import { TxError, buildLaunchTx } from '@/lib/tx.server';

export const dynamic = 'force-dynamic';

const INT128_MAX = (1n << 127n) - 1n;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const bytes = (v: string) => new TextEncoder().encode(v).length;

/** The factory's own text rules, checked here first so a bad field is a 400 rather than a revert. */
const bodySchema = z
  .object({
    account: address,
    name: z.string().trim().refine((v) => bytes(v) >= 1 && bytes(v) <= 64 && !CONTROL.test(v), 'name is 1 to 64 bytes'),
    symbol: z.string().trim().regex(/^[A-Z0-9]{1,16}$/u),
    contractURI: z.string().refine((v) => v.startsWith('ipfs://') && bytes(v) <= 512 && !CONTROL.test(v), 'an ipfs:// contract URI'),
    stock: address,
    metadataEditable: z.boolean().optional(),
    salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/u).optional(),
    buy: z
      .object({
        stockIn: z.string().regex(/^[1-9]\d{0,38}$/u).refine((v) => BigInt(v) <= INT128_MAX, 'stockIn is too large'),
        toleranceBps: z.number().int().min(DEV_TOLERANCE_MIN_BPS).max(DEV_TOLERANCE_MAX_BPS).default(DEV_TOLERANCE_DEFAULT_BPS),
        acknowledgeShare: z.boolean().optional(),
      })
      .optional(),
    builderCode: z.string().regex(BUILDER_CODE).optional(),
  })
  // An editable profile's link must be content-addressed from the start: ipfs:// and a bare CID.
  .refine((b) => !b.metadataEditable || /^ipfs:\/\/[A-Za-z0-9]{1,505}$/u.test(b.contractURI), { message: 'editable profiles need ipfs:// and a bare CID' });

/**
 * The calls for a launch from the account's own wallet: an exact approval of the stock when a buy at
 * launch needs one, then `launchWithOptions` or `launchAndBuy` with the creation fee as its value.
 * The account is the creator; the token lands at `predictedToken`.
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
  if (!parsed.success) {
    return error(400, 'INVALID_BODY', 'Check account, name (1 to 64 bytes), symbol (A-Z, 0-9, up to 16), contractURI (ipfs://), stock and buy.');
  }
  const { buy, salt, ...rest } = parsed.data;
  try {
    const tx = await buildLaunchTx({
      ...rest,
      ...(salt ? { salt: salt as `0x${string}` } : {}),
      ...(buy ? { buy: { stockIn: BigInt(buy.stockIn), toleranceBps: buy.toleranceBps, acknowledgeShare: buy.acknowledgeShare ?? false } } : {}),
    });
    return json(serializable(tx));
  } catch (cause) {
    if (cause instanceof TxError) return json({ error: { code: cause.code, message: cause.message, ...(cause.details ? { details: cause.details } : {}) } }, cause.status);
    return error(502, 'TX_FAILED', 'The launch could not be built right now.');
  }
}
