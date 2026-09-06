import { z } from 'zod';

import { BASE_CONTRACTS } from '@stockpair/core';
import { holderConcentration, listHolders, readMarket } from '@stockpair/core/db';

import { error, json, limitSchema, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

const SUPPLY = 1_000_000_000n * 10n ** 18n;

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');

  const db = await getDb();
  const market = await readMarket(db, token);
  if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No token was launched at this address.');
  const poolManager = BASE_CONTRACTS.poolManager.toLowerCase();
  const [rows, conc] = await Promise.all([listHolders(db, token, parsed.data.limit), holderConcentration(db, token, poolManager)]);
  const pct = (raw: string, of: bigint) => (of === 0n ? 0 : Number((BigInt(raw) * 1_000_000n) / of) / 10_000);
  const circulating = SUPPLY - BigInt(conc.pool_raw) - BigInt(conc.burned_raw);
  const concentration = {
    holders: Number(conc.holders),
    poolPercent: pct(conc.pool_raw, SUPPLY),
    burnedPercent: pct(conc.burned_raw, SUPPLY),
    creatorPercent: pct(conc.creator_raw, SUPPLY),
    top10Percent: pct(conc.top10_raw, SUPPLY),
    top10OfCirculatingPercent: pct(conc.top10_raw, circulating),
    circulatingPercent: pct(circulating.toString(), SUPPLY),
  };
  return json({
    token,
    holderCount: Number(market.holder_count),
    concentration,
    holders: rows.map((row, index) => {
      const raw = BigInt(row.balance_raw);
      return {
        rank: index + 1,
        address: row.holder,
        label:
          row.holder === poolManager
            ? 'Uniswap v4 pool'
            : row.holder === market.creator
              ? 'Creator'
              : row.holder === '0x000000000000000000000000000000000000dead'
                ? 'Burned dust'
                : null,
        balance: Number(raw) / 1e18,
        sharePercent: Number((raw * 1_000_000n) / SUPPLY) / 10_000,
      };
    }),
  });
}
