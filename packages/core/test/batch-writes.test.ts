import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  addSwapFees,
  applyBalanceDeltas,
  insertFeeClaims,
  insertFeeEvents,
  insertLaunches,
  insertSwaps,
  insertTransfers,
  listCandles,
  listHolders,
  listSwaps,
  readBlockHash,
  rebuildCandles,
  upsertBlocks,
} from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

/**
 * The indexer writes one statement per table per range. These cover what a list can do that a
 * single row cannot: repeats inside one statement, chunk boundaries, and the "only new rows move
 * balances" rule that keeps a re-indexed range from double counting.
 */

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000cc';
const CREATOR = '0x1111111111111111111111111111111111111111';
const ALICE = '0x2222222222222222222222222222222222222222';
const BOB = '0x3333333333333333333333333333333333333333';
const POOL = `0x${'cd'.repeat(32)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

let db: Db;

beforeAll(async () => {
  db = await createEmbeddedDb();
  await migrate(db);
  await upsertBlocks(db, [
    { number: 1_000n, hash: '0xb1', parentHash: '0xb0', timestamp: new Date('2026-09-06T09:00:00Z') },
  ]);
  await insertLaunches(db, [
    {
      token: TOKEN,
      stock: NVDAc,
      creator: CREATOR,
      poolId: POOL,
      tokenIsCurrency0: false,
      name: 'Batch Token',
      symbol: 'BATCH',
      contractUri: 'ipfs://bafybatch',
      openingSqrtPriceX96: 123n,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 10n ** 20n,
      stockUsd8: 23_000_000_000n,
      blockNumber: 1_000n,
      blockHash: '0xb1',
      txHash: '0xlaunch',
      logIndex: 0,
      launchedAt: new Date('2026-09-06T09:00:00Z'),
    },
  ]);
});

afterAll(async () => {
  await db.close();
});

describe('upsertBlocks', () => {
  it('writes a list and keeps the last row when a number repeats', async () => {
    await upsertBlocks(db, [
      { number: 2_000n, hash: '0xold', parentHash: '0xp', timestamp: new Date('2026-09-06T10:00:00Z') },
      { number: 2_001n, hash: '0xb2001', parentHash: '0xold', timestamp: new Date('2026-09-06T10:00:02Z') },
      { number: 2_000n, hash: '0xnew', parentHash: '0xp', timestamp: new Date('2026-09-06T10:00:00Z') },
    ]);
    expect(await readBlockHash(db, 2_000n)).toBe('0xnew');
    expect(await readBlockHash(db, 2_001n)).toBe('0xb2001');
  });

  it('splits a list that exceeds one statement into chunks', async () => {
    // 4 columns per block, so the 30k parameter budget holds 7500 rows: 8000 crosses the boundary.
    const many = Array.from({ length: 8_000 }, (_, i) => ({
      number: BigInt(100_000 + i),
      hash: `0xh${i}`,
      parentHash: `0xh${i - 1}`,
      timestamp: new Date('2026-09-06T11:00:00Z'),
    }));
    await upsertBlocks(db, many);
    expect(await readBlockHash(db, 100_000n)).toBe('0xh0');
    expect(await readBlockHash(db, 107_499n)).toBe('0xh7499');
    expect(await readBlockHash(db, 107_500n)).toBe('0xh7500');
    expect(await readBlockHash(db, 107_999n)).toBe('0xh7999');
  });

  it('accepts an empty list', async () => {
    await expect(upsertBlocks(db, [])).resolves.toBeUndefined();
  });
});

describe('insertTransfers and applyBalanceDeltas', () => {
  const blockTime = new Date('2026-09-06T12:00:00Z');
  const mint = {
    txHash: '0xmint',
    logIndex: 0,
    token: TOKEN,
    from: ZERO,
    to: ALICE,
    amountRaw: 1_000n,
    blockNumber: 3_000n,
    blockTime,
  };
  const send = { ...mint, txHash: '0xsend', logIndex: 1, from: ALICE, to: BOB, amountRaw: 400n, blockNumber: 3_001n };

  it('returns only the rows it actually inserted', async () => {
    expect(await insertTransfers(db, [mint, send])).toHaveLength(2);
    // A re-indexed range sees the same logs again and must report none of them as new.
    expect(await insertTransfers(db, [mint, send])).toHaveLength(0);
  });

  it('folds repeated holders in one statement instead of failing on the conflict', async () => {
    await applyBalanceDeltas(db, [
      { token: TOKEN, holder: ALICE, delta: 1_000n, blockNumber: 3_000n },
      { token: TOKEN, holder: ALICE, delta: -400n, blockNumber: 3_001n },
      { token: TOKEN, holder: BOB, delta: 400n, blockNumber: 3_001n },
    ]);
    const holders = await listHolders(db, TOKEN);
    const byHolder = new Map(holders.map((h) => [h.holder, h]));
    expect(byHolder.get(ALICE)?.balance_raw).toBe('600');
    // The fold keeps the highest block the holder was touched at, not the first.
    expect(byHolder.get(ALICE)?.updated_block).toBe('3001');
    expect(byHolder.get(BOB)?.balance_raw).toBe('400');
  });

  it('adds onto balances that already exist', async () => {
    await applyBalanceDeltas(db, [{ token: TOKEN, holder: BOB, delta: 100n, blockNumber: 3_002n }]);
    const bob = (await listHolders(db, TOKEN)).find((h) => h.holder === BOB);
    expect(bob?.balance_raw).toBe('500');
  });
});

describe('insertSwaps, addSwapFees and rebuildCandles', () => {
  const swapBase = {
    token: TOKEN,
    poolId: POOL,
    sender: '0x4444444444444444444444444444444444444444',
    trader: ALICE,
    sqrtPriceX96: 10n ** 20n,
    liquidity: 10n ** 20n,
    tick: 100,
    feeStockRaw: 0n,
    blockHash: '0xb1',
  } as const;

  it('writes a list of swaps and sums several fee logs onto the same swap', async () => {
    await insertSwaps(db, [
      {
        ...swapBase,
        txHash: '0xswap1',
        logIndex: 0,
        side: 'buy',
        amountTokenRaw: 100n,
        amountStockRaw: 10n,
        priceTokenInStock: '0.100000000000000000000000000000',
        blockNumber: 4_000n,
        blockTime: new Date('2026-09-06T13:00:10Z'),
      },
      {
        ...swapBase,
        txHash: '0xswap1',
        logIndex: 1,
        side: 'sell',
        amountTokenRaw: 50n,
        amountStockRaw: 6n,
        priceTokenInStock: '0.120000000000000000000000000000',
        blockNumber: 4_000n,
        blockTime: new Date('2026-09-06T13:00:20Z'),
      },
      {
        ...swapBase,
        txHash: '0xswap2',
        logIndex: 0,
        side: 'buy',
        amountTokenRaw: 200n,
        amountStockRaw: 30n,
        priceTokenInStock: '0.150000000000000000000000000000',
        blockNumber: 4_100n,
        blockTime: new Date('2026-09-06T13:02:00Z'),
      },
    ]);

    // Two swaps through one pool in one transaction, each with its own fee. Each fee belongs to the
    // swap it was charged on; keying the update on the transaction and pool alone gave both rows
    // the combined 7, which is what an arb route through the same pool would have produced.
    await addSwapFees(db, [
      { txHash: '0xswap1', logIndex: 0, poolId: POOL, feeStockRaw: 3n },
      { txHash: '0xswap1', logIndex: 1, poolId: POOL, feeStockRaw: 4n },
      { txHash: '0xswap2', logIndex: 0, poolId: POOL, feeStockRaw: 9n },
    ]);

    const swaps = await listSwaps(db, { token: TOKEN, limit: 10 });
    const fees = new Map(swaps.map((s) => [`${s.tx_hash}|${s.log_index}`, s.fee_stock_raw]));
    expect(fees.get('0xswap1|0')).toBe('3');
    expect(fees.get('0xswap1|1')).toBe('4');
    expect(fees.get('0xswap2|0')).toBe('9');

    // Setting rather than adding, so re-running the same range cannot stack fees onto a row.
    await addSwapFees(db, [{ txHash: '0xswap1', logIndex: 0, poolId: POOL, feeStockRaw: 3n }]);
    const again = await listSwaps(db, { token: TOKEN, limit: 10 });
    expect(again.find((s) => s.tx_hash === '0xswap1' && s.log_index === 0)?.fee_stock_raw).toBe('3');
  });

  it('builds several minute buckets in one call and leaves empty ones alone', async () => {
    await rebuildCandles(db, [
      { token: TOKEN, bucket: new Date('2026-09-06T13:00:00Z') },
      { token: TOKEN, bucket: new Date('2026-09-06T13:02:00Z') },
      // Nothing traded in this minute, so no row should appear for it.
      { token: TOKEN, bucket: new Date('2026-09-06T13:01:00Z') },
    ]);
    const candles = await listCandles(db, TOKEN, { limit: 10 });
    const buckets = candles.map((c) => new Date(c.bucket).toISOString());
    expect(buckets).toContain('2026-09-06T13:00:00.000Z');
    expect(buckets).toContain('2026-09-06T13:02:00.000Z');
    expect(buckets).not.toContain('2026-09-06T13:01:00.000Z');

    const first = candles.find((c) => new Date(c.bucket).toISOString() === '2026-09-06T13:00:00.000Z');
    expect(first?.trade_count).toBe(2);
    expect(first?.open).toBe('0.100000000000000000000000000000');
    expect(first?.close).toBe('0.120000000000000000000000000000');
    expect(first?.volume_stock_raw).toBe('16');
  });
});

describe('insertFeeEvents and insertFeeClaims', () => {
  it('writes lists and ignores logs already stored', async () => {
    const fee = {
      txHash: '0xfee1',
      logIndex: 0,
      poolId: POOL,
      token: TOKEN,
      stock: NVDAc,
      amountRaw: 100n,
      creatorRaw: 70n,
      platformRaw: 30n,
      feeBps: 100,
      blockNumber: 5_000n,
      blockTime: new Date('2026-09-06T14:00:00Z'),
    };
    await insertFeeEvents(db, [fee, { ...fee, txHash: '0xfee2' }]);
    await insertFeeEvents(db, [fee]);
    const rows = await db.query<{ count: string }>('SELECT count(*)::int AS count FROM fee_events');
    expect(Number(rows[0]!.count)).toBe(2);

    const claim = {
      txHash: '0xclaim1',
      logIndex: 0,
      stock: NVDAc,
      account: CREATOR,
      amountRaw: 70n,
      blockNumber: 5_001n,
      blockTime: new Date('2026-09-06T14:01:00Z'),
    };
    await insertFeeClaims(db, [claim, { ...claim, txHash: '0xclaim2' }]);
    const claims = await db.query<{ count: string }>('SELECT count(*)::int AS count FROM fee_claims');
    expect(Number(claims[0]!.count)).toBe(2);
  });
});
