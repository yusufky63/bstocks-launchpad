import { beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  countPendingAlerts,
  enqueueAlerts,
  insertLaunch,
  listPendingAlerts,
  markAlertsSent,
  pruneSentAlerts,
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

  it('prunes sent rows once they are old, and never pending ones', async () => {
    await enqueueAlerts(db, [
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_011n, payload: { n: 1 } },
      { kind: 'trade', token: TOKEN, blockNumber: 50_900_012n, payload: { n: 2 } },
    ]);
    const all = await listPendingAlerts(db);
    await markAlertsSent(db, all.map((a) => a.id));
    await db.query("UPDATE alert_outbox SET sent_at = now() - interval '60 days' WHERE id = $1", [all[0]!.id]);

    expect(await pruneSentAlerts(db, 30)).toBe(1);
    const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM alert_outbox');
    expect(Number(rows[0]!.count)).toBe(1);
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
