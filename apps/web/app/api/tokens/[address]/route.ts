import { findStock } from '@stockpair/core';

import { error, json, parseAddressParam } from '@/lib/api.server';
import { cached, TTL } from '@/lib/cache.server';
import { getDb } from '@/lib/db.server';
import { readLaunchOnchain } from '@/lib/onchain.server';
import { readMarketCached, readTokenDetails } from '@/lib/token.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

/**
 * One token. `indexed` carries the market row plus fees, lifetime figures and pool reserves;
 * `indexing` means the launch is confirmed onchain but not yet stored; 404 means no such launch.
 */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');

  const db = await getDb();
  const market = await readMarketCached(db, token);
  if (market) {
    const details = await readTokenDetails(db, market);
    return json({ status: 'indexed', market, details });
  }

  const onchain = await cached(`onchain:${token}`, TTL.chain, () => readLaunchOnchain(token));
  if (!onchain) return error(404, 'TOKEN_NOT_FOUND', 'No StockPair launch exists for this address.');
  const stock = findStock(onchain.stock);
  return json({ status: 'indexing', launch: { ...onchain, stockSymbol: stock?.symbol ?? null, stockTicker: stock?.ticker ?? null } });
}
