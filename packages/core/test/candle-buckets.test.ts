import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { insertLaunch, insertSwap, isCandleBucket, listCandles, rebuildCandle, upsertBlock } from '../src/db/queries';

const TOKEN = '0x1111111111111111111111111111111111111111';
const STOCK = '0xb2000000000000000000001e800a7f5189430cd0';
const POOL = '0x2222222222222222222222222222222222222222';
const TRADER = '0x4444444444444444444444444444444444444444';

let db: Db;

/**
 * The candles table stores one row per minute and the read is capped at 2000 rows, a little over
 * thirty-three hours. Grouping in the browser therefore spent the whole cap on minutes that were
 * about to be added together: the four-hour view had eight candles on it and a daily view was not
 * worth offering at all. Grouping in SQL spends the cap on the bucket the caller asked for.
 */
describe('listCandles bucketing', () => {
  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    await upsertBlock(db, { number: 50_900_000n, hash: '0xb1', parentHash: '0xb0', timestamp: new Date('2026-09-05T00:00:00Z') });
    await insertLaunch(db, {
      token: TOKEN,
      stock: STOCK,
      creator: TRADER,
      poolId: POOL,
      name: 'Probe',
      symbol: 'PRB',
      contractUri: 'ipfs://x',
      tokenIsCurrency0: true,
      openingSqrtPriceX96: 123n,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 10n ** 20n,
      stockUsd8: 36_627_000_000n,
      txHash: '0xl1',
      logIndex: 0,
      blockNumber: 50_900_000n,
      blockHash: '0xb1',
      launchedAt: new Date('2026-09-05T00:00:00Z'),
    });

    // Four minutes, each its own candle, spanning two five-minute buckets and one hour.
    const minutes = [
      { at: '2026-09-05T12:01:00Z', price: '0.000000021000000000000000000000', vol: 10_000_000n },
      { at: '2026-09-05T12:03:00Z', price: '0.000000025000000000000000000000', vol: 20_000_000n },
      { at: '2026-09-05T12:07:00Z', price: '0.000000019000000000000000000000', vol: 30_000_000n },
      { at: '2026-09-05T12:09:00Z', price: '0.000000023000000000000000000000', vol: 40_000_000n },
    ];
    let n = 0;
    for (const m of minutes) {
      n += 1;
      await insertSwap(db, {
        token: TOKEN,
        poolId: POOL,
        sender: TRADER,
        trader: TRADER,
        liquidity: 10n ** 20n,
        blockHash: '0xb1',
        feeStockRaw: 1_000n,
        txHash: `0xs${n}`,
        logIndex: 1,
        side: 'buy',
        amountTokenRaw: 1_000n * 10n ** 18n,
        amountStockRaw: m.vol,
        priceTokenInStock: m.price,
        sqrtPriceX96: 456n,
        tick: 1,
        blockNumber: 50_900_000n + BigInt(n),
        blockTime: new Date(m.at),
      });
      await rebuildCandle(db, TOKEN, new Date(m.at));
    }
  });

  afterAll(async () => {
    await db.end?.();
  });

  it('returns one row per minute when nothing is asked for', async () => {
    expect(await listCandles(db, TOKEN)).toHaveLength(4);
  });

  it('groups four minutes into two five-minute candles', async () => {
    const rows = await listCandles(db, TOKEN, { bucketMinutes: 5 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.trade_count)).toEqual([2, 2]);
  });

  /**
   * open is the first minute of the bucket and close the last. Getting that backwards would turn a
   * rising bucket into a falling one, which is the failure a summary would not notice.
   */
  it('keeps open first and close last inside a bucket', async () => {
    const [first] = await listCandles(db, TOKEN, { bucketMinutes: 5 });
    expect(Number(first?.open)).toBeCloseTo(2.1e-8, 12);
    expect(Number(first?.close)).toBeCloseTo(2.5e-8, 12);
    expect(Number(first?.high)).toBeCloseTo(2.5e-8, 12);
    expect(Number(first?.low)).toBeCloseTo(2.1e-8, 12);
  });

  it('sums volume and trades rather than sampling them', async () => {
    const [only] = await listCandles(db, TOKEN, { bucketMinutes: 1_440 });
    expect(only?.trade_count).toBe(4);
    expect(only?.volume_stock_raw).toBe('100000000');
  });

  it('collapses the whole day into one candle, open to close', async () => {
    const rows = await listCandles(db, TOKEN, { bucketMinutes: 1_440 });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.open)).toBeCloseTo(2.1e-8, 12);
    expect(Number(rows[0]?.close)).toBeCloseTo(2.3e-8, 12);
    expect(Number(rows[0]?.high)).toBeCloseTo(2.5e-8, 12);
    expect(Number(rows[0]?.low)).toBeCloseTo(1.9e-8, 12);
  });

  it('returns candles oldest first, whatever the width', async () => {
    for (const bucketMinutes of [1, 5, 60, 1_440] as const) {
      const rows = await listCandles(db, TOKEN, { bucketMinutes });
      const times = rows.map((r) => new Date(r.bucket).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  /** The width reaches SQL, so it is a whitelist rather than a number from the caller. */
  it('accepts only the widths the chart offers', () => {
    for (const ok of [1, 5, 15, 60, 240, 1_440]) expect(isCandleBucket(ok)).toBe(true);
    for (const no of [0, 2, 7, 1_439, -60, 100_000]) expect(isCandleBucket(no)).toBe(false);
  });
});
