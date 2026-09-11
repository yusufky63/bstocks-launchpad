import { beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  countPendingAlerts,
  enqueueAlerts,
  insertLaunch,
  listPendingAlerts,
  markAlertsSent,
  pruneAlerts,
  readAlertMark,
  rollbackFrom,
  setAlertMark,
  upsertBlock,
} from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000aa';
const CREATOR = '0x1111111111111111111111111111111111111111';

let db: Db;

async function launchAt(block: bigint) {
  await upsertBlock(db, { number: block, hash: `0xb${block}`, parentHash: '0xb0', timestamp: new Date('2026-09-05T12:00:00Z') });
  await insertLaunch(db, {
    token: TOKEN, stock: NVDAc, creator: CREATOR, poolId: `0x${'ab'.repeat(32)}`,
    tokenIsCurrency0: false, name: 'Test', symbol: 'TEST', contractUri: 'ipfs://x',
    openingSqrtPriceX96: 1n, tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n,
    stockUsd8: 22_995_730_000n, blockNumber: block, blockHash: `0xb${block}`, txHash: '0xt1',
    logIndex: 0, launchedAt: new Date('2026-09-05T12:00:00Z'),
  });
}

describe('the alert outbox', () => {
  beforeEach(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    await launchAt(50_900_010n);
  });

  it('hands rows back in the order they happened, with the payload intact', async () => {
    await enqueueAlerts(db, [
      { kind: 'launch', token: TOKEN, blockNumber: 50_900_010n, payload: { symbol: 'TEST' } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { side: 'buy', amountStockRaw: '99000000' } },
    ]);

    const pending = await listPendingAlerts(db);
    expect(pending.map((a) => a.kind)).toEqual(['launch', 'trade']);
    // A post has to say what a trade was worth when it happened, so the payload is stored whole
    // rather than re-derived at send time.
    expect(pending[1]?.payload).toEqual({ side: 'buy', amountStockRaw: '99000000' });
    expect(await countPendingAlerts(db)).toBe(2);
  });

  // The whole point of enqueueing inside the indexer's transaction rather than after it. If this
  // ever fails, someone has moved the call out of the transaction and the channel can announce a
  // block that was never committed.
  it('leaves nothing behind when the transaction that queued it rolls back', async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueAlerts(tx, [{ kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 } }]);
        throw new Error('the sync pass failed after queueing');
      }),
    ).rejects.toThrow('the sync pass failed');

    expect(await countPendingAlerts(db)).toBe(0);
  });

  it('keeps what a committed transaction queued', async () => {
    await db.transaction(async (tx) => {
      await enqueueAlerts(tx, [{ kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 } }]);
    });
    expect(await countPendingAlerts(db)).toBe(1);
  });

  // A reorg deletes a swap and the next pass re-indexes it. The swap itself lands once because
  // insertSwaps is keyed on (tx_hash, log_index); without the same key here the announcement went
  // out twice.
  it('refuses to queue the same event twice, even after it has been sent', async () => {
    const one = { kind: 'trade' as const, token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 }, dedupeKey: 'trade:0xabc:3' };
    await enqueueAlerts(db, [one]);
    await enqueueAlerts(db, [one]);
    expect(await countPendingAlerts(db)).toBe(1);

    const [first] = await listPendingAlerts(db);
    await markAlertsSent(db, [first!.id]);
    await enqueueAlerts(db, [one]);
    expect(await countPendingAlerts(db)).toBe(0);
  });

  it('still queues everything when no key is given', async () => {
    const anon = { kind: 'trade' as const, token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 } };
    await enqueueAlerts(db, [anon, anon]);
    expect(await countPendingAlerts(db)).toBe(2);
  });

  it('stops handing back what has been sent', async () => {
    await enqueueAlerts(db, [
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_012n, payload: { n: 2 } },
    ]);
    const [first] = await listPendingAlerts(db);
    await markAlertsSent(db, [first!.id]);

    const rest = await listPendingAlerts(db);
    expect(rest).toHaveLength(1);
    expect(rest[0]?.payload).toEqual({ n: 2 });
  });

  // The channel must never announce a trade that did not survive. But an announcement already
  // posted is a record of what was said, and deleting the row would not unsay it.
  it('withdraws unsent announcements for reorged blocks and keeps the sent ones', async () => {
    await enqueueAlerts(db, [
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 'sent' } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_012n, payload: { n: 'unsent' } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_009n, payload: { n: 'below the rollback' } },
    ]);
    const all = await listPendingAlerts(db);
    await markAlertsSent(db, [all.find((a) => (a.payload as { n: string }).n === 'sent')!.id]);

    await rollbackFrom(db, 50_900_011n);

    const left = await listPendingAlerts(db, 100);
    expect(left.map((a) => (a.payload as { n: string }).n)).toEqual(['below the rollback']);
    // The sent row is still there, just not pending.
    const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM alert_outbox');
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('prunes sent rows once they are old, and stale unsent ones too', async () => {
    await enqueueAlerts(db, [
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_012n, payload: { n: 2 } },
    ]);
    const all = await listPendingAlerts(db);
    await markAlertsSent(db, all.map((a) => a.id));
    await db.query("UPDATE alert_outbox SET sent_at = now() - interval '60 days' WHERE id = $1", [all[0]!.id]);

    expect(await pruneAlerts(db, 30, 3)).toBe(1);
    expect(Number((await db.query<{ c: string }>('SELECT count(*)::text AS c FROM alert_outbox'))[0]!.c)).toBe(1);
  });

  // If the service is off for a month the indexer keeps queueing, and nobody wants a Tuesday
  // trade announced in March.
  it('drops unsent rows that are no longer news', async () => {
    await enqueueAlerts(db, [
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 'old' } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_012n, payload: { n: 'fresh' } },
    ]);
    const all = await listPendingAlerts(db);
    await db.query("UPDATE alert_outbox SET created_at = now() - interval '10 days' WHERE id = $1", [all[0]!.id]);

    expect(await pruneAlerts(db, 30, 3)).toBe(1);
    const left = await listPendingAlerts(db);
    expect(left.map((a) => (a.payload as { n: string }).n)).toEqual(['fresh']);
  });
});

describe('alert marks', () => {
  beforeEach(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
  });

  // A milestone is crossed once. Without this a restart re-announces every level every token has
  // ever passed.
  it('remembers the highest level announced for a token', async () => {
    expect(await readAlertMark(db, TOKEN, 'mcap')).toBeNull();

    await setAlertMark(db, TOKEN, 'mcap', '25000');
    expect((await readAlertMark(db, TOKEN, 'mcap'))?.value).toBe('25000.000000000000000000000000000000');

    await setAlertMark(db, TOKEN, 'mcap', '50000');
    expect(Number((await readAlertMark(db, TOKEN, 'mcap'))?.value)).toBe(50_000);
  });
});
