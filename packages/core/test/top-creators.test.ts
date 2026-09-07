import { beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { insertFeeEvent, insertLaunch, topCreatorsByFees } from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TSLAc = BASE_STOCKS[1]!.address.toLowerCase();
const RICH = '0x1111111111111111111111111111111111111111';
const POOR = '0x2222222222222222222222222222222222222222';

let db: Db;
let seq = 0;

async function launch(token: string, creator: string, stock: string) {
  await insertLaunch(db, {
    token, stock, creator,
    poolId: `0x${(seq + 10).toString(16).padStart(64, '0')}`,
    tokenIsCurrency0: false,
    name: `T${seq}`, symbol: `T${seq}`, contractUri: 'ipfs://x',
    openingSqrtPriceX96: 123n, tickLower: -887_200, tickUpper: 100,
    liquidity: 10n ** 20n, stockUsd8: 22_995_730_000n,
    blockNumber: BigInt(50_900_000 + seq), blockHash: `0xb${seq}`,
    txHash: `0xl${seq}`, logIndex: seq, launchedAt: new Date('2026-09-05T12:00:00Z'),
  });
  seq += 1;
}

async function fee(token: string, stock: string, creatorRaw: bigint) {
  seq += 1;
  await insertFeeEvent(db, {
    txHash: `0xf${seq}`, logIndex: 0, poolId: `0x${'ab'.repeat(32)}`,
    token, stock,
    amountRaw: (creatorRaw * 10n) / 7n, creatorRaw, platformRaw: (creatorRaw * 3n) / 7n,
    feeBps: 100, blockNumber: BigInt(50_900_500 + seq), blockTime: new Date('2026-09-05T12:05:00Z'),
  });
}

describe('topCreatorsByFees', () => {
  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    // RICH has two tokens against two different stocks; POOR has one.
    await launch('0xb2000000000000000000000000000000000000a1', RICH, NVDAc);
    await launch('0xb2000000000000000000000000000000000000a2', RICH, TSLAc);
    await launch('0xb2000000000000000000000000000000000000b1', POOR, NVDAc);
    await fee('0xb2000000000000000000000000000000000000a1', NVDAc, 700_000n);
    await fee('0xb2000000000000000000000000000000000000a1', NVDAc, 300_000n); // same stock, must sum
    await fee('0xb2000000000000000000000000000000000000a2', TSLAc, 500_000n);
    await fee('0xb2000000000000000000000000000000000000b1', NVDAc, 100_000n);
  });

  it('ranks creators by total fees and splits their earnings per stock', async () => {
    const rows = await topCreatorsByFees(db, 10);

    // RICH earned 1.5M across two stocks, POOR 100k: RICH's rows must come first.
    expect(rows[0]!.creator).toBe(RICH);
    expect(rows.at(-1)!.creator).toBe(POOR);

    const richByStock = new Map(rows.filter((r) => r.creator === RICH).map((r) => [r.stock, r.creator_raw]));
    expect(richByStock.get(NVDAc)).toBe('1000000'); // the two NVDAc fees summed
    expect(richByStock.get(TSLAc)).toBe('500000');

    // Token count is per creator, not per row.
    expect(rows.filter((r) => r.creator === RICH).every((r) => r.tokens === 2)).toBe(true);
    expect(rows.find((r) => r.creator === POOR)!.tokens).toBe(1);
  });

  it('honours the creator limit rather than a row limit', async () => {
    const rows = await topCreatorsByFees(db, 1);
    expect(new Set(rows.map((r) => r.creator))).toEqual(new Set([RICH]));
    expect(rows).toHaveLength(2); // one row per stock for that single creator
  });
});
