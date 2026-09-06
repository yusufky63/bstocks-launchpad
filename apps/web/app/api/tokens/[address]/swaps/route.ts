import { z } from 'zod';

import { listSwaps, readMarket } from '@stockpair/core/db';

import { error, json, limitSchema, parseAddressParam, serializable } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

const querySchema = z.object({
  limit: limitSchema,
  before: z.coerce.bigint().optional(),
});

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');

  const db = await getDb();
  const market = await readMarket(db, token);
  if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No StockPair launch exists for this address.');
  const rows = await listSwaps(db, {
    token,
    limit: parsed.data.limit,
    ...(parsed.data.before !== undefined ? { beforeBlock: parsed.data.before } : {}),
  });
  const stockUsd = market.stock_usd8 === null ? null : Number(market.stock_usd8) / 1e8;
  const stockUnit = 10 ** Number(market.stock_decimals);
  return json({
    token,
    stock: { address: market.stock, symbol: market.stock_symbol, decimals: Number(market.stock_decimals) },
    stockUsd,
    swaps: rows.map((row) =>
      serializable({
        txHash: row.tx_hash,
        logIndex: row.log_index,
        side: row.side,
        trader: row.trader,
        sender: row.sender,
        amountToken: Number(row.amount_token_raw) / 1e18,
        amountStock: Number(row.amount_stock_raw) / stockUnit,
        feeStock: Number(row.fee_stock_raw) / stockUnit,
        amountUsd: stockUsd === null ? null : (Number(row.amount_stock_raw) / stockUnit) * stockUsd,
        price: Number(row.price_token_in_stock),
        priceUsd: stockUsd === null ? null : Number(row.price_token_in_stock) * stockUsd,
        blockNumber: row.block_number,
        blockTime: new Date(row.block_time).toISOString(),
        isCreator: row.is_creator,
      }),
    ),
  });
}
