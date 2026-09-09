import { beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { insertLaunch, insertSwap, listMarkets, upsertBlock } from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000aa';
const POOL = `0x${'ab'.repeat(32)}`;

let db: Db;

/** A swap of `stock` units at `at`; the amounts are what the totals sum. */
async function swap(n: number, at: Date, stockRaw: bigint) {
  await upsertBlock(db, { number: BigInt(50_900_000 + n), hash: `0xb${n}`, parentHash: `0xb${n - 1}`, timestamp: at });
  await insertSwap(db, {
    txHash: `0xs${n}`, logIndex: 0, token: TOKEN, poolId: POOL, side: 'buy',
    sender: '0x3333333333333333333333333333333333333333',
    trader: '0x2222222222222222222222222222222222222222',
    amountTokenRaw: 10n ** 18n, amountStockRaw: stockRaw, priceTokenInStock: '1',
    sqrtPriceX96: 1n, liquidity: 1n, tick: 0, feeStockRaw: 0n,
    blockNumber: BigInt(50_900_000 + n), blockHash: `0xb${n}`, blockTime: at,
  });
}

describe('market totals', () => {
  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    await insertLaunch(db, {
      token: TOKEN, stock: NVDAc, creator: '0x1111111111111111111111111111111111111111',
      poolId: POOL, tokenIsCurrency0: false, name: 'Test', symbol: 'TEST', contractUri: 'ipfs://x',
      openingSqrtPriceX96: 1n, tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n, blockNumber: 50_899_999n, blockHash: '0xb0', txHash: '0xt0',
      logIndex: 0, launchedAt: new Date(Date.now() - 5 * 24 * 3_600_000),
    });
    // Two swaps inside the last day, one well outside it.
    await swap(1, new Date(Date.now() - 3 * 24 * 3_600_000), 700n);
    await swap(2, new Date(Date.now() - 3_600_000), 200n);
    await swap(3, new Date(Date.now() - 600_000), 100n);
  });

  it('reports lifetime and 24h volume and trades separately', async () => {
    const [market] = await listMarkets(db, { tokens: [TOKEN] });

    // 24h sees the two recent swaps; lifetime sees all three.
    expect(Number(market!.volume_24h_stock_raw)).toBe(300);
    expect(market!.trades_24h).toBe(2);
    expect(Number(market!.volume_all_stock_raw)).toBe(1_000);
    expect(market!.trades_all).toBe(3);
  });

  it('counts a token with no swaps as zero rather than null', async () => {
    const empty = '0xb2000000000000000000000000000000000000bb';
    await insertLaunch(db, {
      token: empty, stock: NVDAc, creator: '0x1111111111111111111111111111111111111111',
      poolId: `0x${'cd'.repeat(32)}`, tokenIsCurrency0: false, name: 'Empty', symbol: 'EMPTY',
      contractUri: 'ipfs://y', openingSqrtPriceX96: 1n, tickLower: -887_200, tickUpper: 100,
      liquidity: 10n ** 20n, stockUsd8: 22_995_730_000n, blockNumber: 50_899_998n,
      blockHash: '0xb00', txHash: '0xt00', logIndex: 0, launchedAt: new Date(),
    });
    const rows = await listMarkets(db, { tokens: [empty] });
    expect(Number(rows[0]!.volume_all_stock_raw)).toBe(0);
    expect(rows[0]!.trades_all).toBe(0);
  });
});
