import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  applyBalanceDelta,
  BURN_ADDRESS,
  insertLaunch,
  insertSwap,
  insertTransfer,
  listActivity,
  listBurns,
  listMarkets,
  platformStats,
  readMarket,
  rollbackFrom,
  tokenBurns,
  upsertStockQuote,
} from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000b1';
const QUIET = '0xb2000000000000000000000000000000000000b2';
const FACTORY = '0xfac7000000000000000000000000000000000001';
const CREATOR = '0x1111111111111111111111111111111111111111';
const ALICE = '0x2222222222222222222222222222222222222222';
const BOB = '0x3333333333333333333333333333333333333333';
const WHOLE = 10n ** 18n;

let db: Db;

async function launch(token: string, txHash: string, block: bigint, at: Date) {
  await insertLaunch(db, {
    token,
    stock: NVDAc,
    creator: CREATOR,
    poolId: `0x${token.slice(-2).repeat(32)}`,
    tokenIsCurrency0: true,
    name: `Token ${token.slice(-2)}`,
    symbol: `T${token.slice(-2)}`,
    contractUri: 'ipfs://bafyburn',
    openingSqrtPriceX96: 1n,
    tickLower: -887_200,
    tickUpper: 100,
    liquidity: 1n,
    stockUsd8: 200n * 10n ** 8n,
    blockNumber: block,
    blockHash: '0xb',
    txHash,
    logIndex: 3,
    launchedAt: at,
  });
  // The launch's own rounding dust, sent to the burn address by the factory in the launch transaction.
  await insertTransfer(db, { txHash, logIndex: 2, token, from: FACTORY, to: BURN_ADDRESS, amountRaw: 5n, blockNumber: block, blockTime: at });
  await applyBalanceDelta(db, token, BURN_ADDRESS, 5n, block);
}

async function burn(token: string, from: string, whole: bigint, txHash: string, block: bigint, at: Date) {
  await insertTransfer(db, { txHash, logIndex: 0, token, from, to: BURN_ADDRESS, amountRaw: whole * WHOLE, blockNumber: block, blockTime: at });
  await applyBalanceDelta(db, token, BURN_ADDRESS, whole * WHOLE, block);
}

beforeAll(async () => {
  db = await createEmbeddedDb();
  await migrate(db);
  await upsertStockQuote(db, { stock: NVDAc, priceUsd8: 200n * 10n ** 8n, feedUpdatedAt: new Date('2026-10-01T00:00:00Z'), observedAt: new Date('2026-10-01T00:00:00Z'), observedBlock: 1n });
  await launch(TOKEN, '0xlaunch1', 100n, new Date('2026-10-01T10:00:00Z'));
  await launch(QUIET, '0xlaunch2', 101n, new Date('2026-10-01T10:00:02Z'));

  // A burn before the token's first trade has nothing to price it with.
  await burn(TOKEN, ALICE, 1_000n, '0xburn0', 105n, new Date('2026-10-01T10:00:10Z'));
  await insertSwap(db, {
    txHash: '0xswap1',
    logIndex: 1,
    token: TOKEN,
    poolId: `0x${'b1'.repeat(32)}`,
    side: 'buy',
    sender: '0x00000000000000000000000000000000000000e0',
    trader: ALICE,
    amountTokenRaw: 10_000n * WHOLE,
    amountStockRaw: 100_000_000n,
    priceTokenInStock: '0.000100000000000000000000000000',
    sqrtPriceX96: 1n,
    liquidity: 1n,
    tick: 0,
    feeStockRaw: 0n,
    blockNumber: 110n,
    blockHash: '0xb',
    blockTime: new Date('2026-10-01T10:00:20Z'),
  });
  // The stock moved before the next burn: it is valued at the quote in effect then, 250, not today's.
  await upsertStockQuote(db, { stock: NVDAc, priceUsd8: 250n * 10n ** 8n, feedUpdatedAt: new Date('2026-10-01T10:00:30Z'), observedAt: new Date('2026-10-01T10:00:30Z'), observedBlock: 2n });
  await burn(TOKEN, BOB, 2_000n, '0xburn1', 120n, new Date('2026-10-01T10:00:40Z'));
  await burn(TOKEN, CREATOR, 500n, '0xburn2', 130n, new Date('2026-10-01T10:00:50Z'));
  await upsertStockQuote(db, { stock: NVDAc, priceUsd8: 300n * 10n ** 8n, feedUpdatedAt: new Date('2026-10-01T11:00:00Z'), observedAt: new Date('2026-10-01T11:00:00Z'), observedBlock: 3n });
});

afterAll(async () => {
  await db.close();
});

describe('burns', () => {
  it('lists burns newest first, without the launch dust, each valued when it happened', async () => {
    const rows = await listBurns(db, { token: TOKEN });
    expect(rows.map((r) => [r.tx_hash, r.burner, r.amount_raw, r.is_creator])).toEqual([
      ['0xburn2', CREATOR, (500n * WHOLE).toString(), true],
      ['0xburn1', BOB, (2_000n * WHOLE).toString(), false],
      ['0xburn0', ALICE, (1_000n * WHOLE).toString(), false],
    ]);
    expect(Number(rows[1]!.price_at_burn)).toBeCloseTo(0.0001, 12);
    expect(rows[1]!.stock_usd8_at_burn).toBe((250n * 10n ** 8n).toString());
    expect(rows[2]!.price_at_burn).toBeNull();
    expect(rows[0]).toMatchObject({ symbol: 'Tb1', stock_symbol: 'NVDAc', stock_decimals: 8 });
    expect(await listBurns(db, { token: QUIET })).toEqual([]);
  });

  it('pages back by block and log, and filters by burner', async () => {
    const page = await listBurns(db, { token: TOKEN, limit: 1, beforeBlock: 130n, beforeLogIndex: 0 });
    expect(page.map((r) => r.tx_hash)).toEqual(['0xburn1']);
    expect((await listBurns(db, { burner: BOB.toUpperCase().replace('0X', '0x') })).map((r) => r.tx_hash)).toEqual(['0xburn1']);
  });

  it('totals a token\'s burns and ranks its burners', async () => {
    const totals = await tokenBurns(db, TOKEN);
    expect(totals).toMatchObject({ burned_raw: (3_500n * WHOLE).toString(), burns: 3, burners: 3, last_burn_block: '130' });
    expect(totals.last_burn_at).toEqual(new Date('2026-10-01T10:00:50Z'));
    expect(totals.top.map((t) => t.burner)).toEqual([BOB, ALICE, CREATOR]);
    expect(await tokenBurns(db, QUIET)).toMatchObject({ burned_raw: '0', burns: 0, burners: 0, last_burn_at: null, top: [] });
  });

  it('puts the burned amount on every market row', async () => {
    expect(await readMarket(db, TOKEN)).toMatchObject({ burned_raw: (3_500n * WHOLE).toString(), burns: 3, last_burn_block: '130' });
    // Dust alone is not a burn.
    expect(await readMarket(db, QUIET)).toMatchObject({ burned_raw: '0', burns: 0, last_burn_block: null });
    const listed = await listMarkets(db);
    expect(listed.find((m) => m.token === TOKEN)?.burns).toBe(3);
  });

  it('shows burns in the activity feed', async () => {
    const feed = await listActivity(db, { token: TOKEN });
    expect(feed.map((r) => r.kind)).toEqual(['burn', 'burn', 'swap', 'burn', 'launch']);
    expect(feed[0]).toMatchObject({ actor: CREATOR, is_creator: true, side: null, amount_stock_raw: null });
    expect(feed[0]!.amount_token_raw).toBe((500n * WHOLE).toString());
    expect((await listActivity(db, { actor: BOB })).map((r) => r.kind)).toEqual(['burn']);
  });

  it('adds burns to the platform totals, valuing only what had a price', async () => {
    const stats = await platformStats(db);
    expect(stats).toMatchObject({ burns: 3, burners: 3, tokens_burned: 1 });
    // 2000 at 0.0001 NVDAc and $250, plus 500 at the same price and quote. The first burn had no price.
    expect(Number(stats.burned_usd)).toBeCloseTo(2_000 * 0.0001 * 250 + 500 * 0.0001 * 250, 9);
  });

  it('drops burns with the blocks a reorg takes back', async () => {
    await rollbackFrom(db, 125n);
    expect((await tokenBurns(db, TOKEN)).burns).toBe(2);
    expect((await readMarket(db, TOKEN))?.burns).toBe(2);
  });
});
