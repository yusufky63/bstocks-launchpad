import { beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { insertLaunch, insertSwap, listMarkets, upsertBlock, upsertStockQuote } from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
let db: Db;
let n = 0;

async function launch(token: string, symbol: string, minutesAgo: number) {
  n += 1;
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await upsertBlock(db, { number: BigInt(50_900_000 + n), hash: `0xb${n}`, parentHash: '0xb0', timestamp: at });
  await insertLaunch(db, {
    token, stock: NVDAc, creator: '0x1111111111111111111111111111111111111111',
    poolId: `0x${token.slice(-2).repeat(32)}`, tokenIsCurrency0: false,
    name: symbol, symbol, contractUri: 'ipfs://x', openingSqrtPriceX96: 1n,
    tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n, stockUsd8: 22_995_730_000n,
    blockNumber: BigInt(50_900_000 + n), blockHash: `0xb${n}`, txHash: `0xt${n}`, logIndex: 0, launchedAt: at,
  });
}

async function trade(token: string, stockRaw: bigint) {
  n += 1;
  const at = new Date(Date.now() - 60_000);
  await upsertBlock(db, { number: BigInt(50_910_000 + n), hash: `0xs${n}`, parentHash: '0xb0', timestamp: at });
  await insertSwap(db, {
    txHash: `0xsw${n}`, logIndex: 0, token, poolId: `0x${token.slice(-2).repeat(32)}`, side: 'buy',
    sender: '0x3333333333333333333333333333333333333333', trader: '0x2222222222222222222222222222222222222222',
    amountTokenRaw: 10n ** 18n, amountStockRaw: stockRaw, priceTokenInStock: '1',
    sqrtPriceX96: 1n, liquidity: 1n, tick: 0, feeStockRaw: 0n,
    blockNumber: BigInt(50_910_000 + n), blockHash: `0xs${n}`, blockTime: at,
  });
}

describe('listMarkets ordering', () => {
  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    await upsertStockQuote(db, { stock: NVDAc, priceUsd8: 22_995_730_000n, feedUpdatedAt: new Date(), observedAt: new Date(), observedBlock: 1n });
    // BUSY launched first and trades; QUIET launched last and never trades.
    await launch('0xb2000000000000000000000000000000000000aa', 'BUSY', 600);
    await launch('0xb2000000000000000000000000000000000000bb', 'QUIET', 1);
    await trade('0xb2000000000000000000000000000000000000aa', 5_000_000n);
  });

  it('defaults to newest first', async () => {
    const rows = await listMarkets(db, {});
    expect(rows.map((r) => r.symbol)).toEqual(['QUIET', 'BUSY']);
  });

  // The whole point: ranking has to be done by the query, because a caller can only sort the page
  // it was handed, and a mover outside that page would never appear.
  it('puts the traded token first when ranking by 24h volume, regardless of launch order', async () => {
    const rows = await listMarkets(db, { orderBy: 'volume24h' });
    expect(rows.map((r) => r.symbol)).toEqual(['BUSY', 'QUIET']);
  });

  it('still respects the limit when ranking by volume', async () => {
    const rows = await listMarkets(db, { orderBy: 'volume24h', limit: 1 });
    expect(rows.map((r) => r.symbol)).toEqual(['BUSY']);
  });
});
