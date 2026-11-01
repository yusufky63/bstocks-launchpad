import 'server-only';

import { listBurns, tokenBurns, type BurnRow, type Db } from '@stockpair/core/db';

import { cached, TTL } from './cache.server';
import { imageProxyUrl, supplyPercent } from './market-view';
import type { BurnsResponse, BurnView } from './types';

/** A burn as the API and the pages show it, valued at the token's price and the stock quote when it happened. */
export function toBurnView(row: BurnRow): BurnView {
  const amount = Number(row.amount_raw) / 1e18;
  const price = row.price_at_burn === null ? null : Number(row.price_at_burn);
  const stockUsd = row.stock_usd8_at_burn === null ? null : Number(row.stock_usd8_at_burn) / 1e8;
  return {
    txHash: row.tx_hash,
    logIndex: Number(row.log_index),
    token: row.token,
    name: row.name,
    symbol: row.symbol,
    imageUrl: imageProxyUrl(row.token, row.image_uri),
    burner: row.burner,
    isCreator: row.is_creator,
    amount,
    amountRaw: row.amount_raw,
    supplyPercent: supplyPercent(row.amount_raw),
    valueUsd: price === null || stockUsd === null ? null : amount * price * stockUsd,
    blockNumber: String(row.block_number),
    blockTime: new Date(row.block_time).toISOString(),
  };
}

/**
 * One token's burns, newest first. The first page also carries the totals and the largest burners;
 * it is what an open token page polls, so viewers share it for a second.
 */
export async function readTokenBurns(
  db: Db,
  token: string,
  symbol: string,
  page: { limit: number; before?: bigint; beforeLog?: number },
): Promise<BurnsResponse> {
  const read = async (): Promise<BurnsResponse> => {
    const first = page.before === undefined;
    const [rows, totals] = await Promise.all([
      listBurns(db, {
        token,
        limit: page.limit,
        ...(page.before !== undefined ? { beforeBlock: page.before } : {}),
        ...(page.beforeLog !== undefined ? { beforeLogIndex: page.beforeLog } : {}),
      }),
      first ? tokenBurns(db, token, 10) : Promise.resolve(null),
    ]);
    return {
      token,
      symbol,
      summary: totals && {
        burned: Number(totals.burned_raw) / 1e18,
        burnedRaw: totals.burned_raw,
        supplyPercent: supplyPercent(totals.burned_raw),
        burns: totals.burns,
        burners: totals.burners,
        lastBurnAt: totals.last_burn_at ? new Date(totals.last_burn_at).toISOString() : null,
        lastBurnBlock: totals.last_burn_block,
        top: totals.top.map((t) => ({ burner: t.burner, burned: Number(t.burned_raw) / 1e18, supplyPercent: supplyPercent(t.burned_raw), burns: t.burns })),
      },
      burns: rows.map(toBurnView),
    };
  };
  return page.before === undefined ? cached(`burns:${token}:${page.limit}`, TTL.live, read) : read();
}
