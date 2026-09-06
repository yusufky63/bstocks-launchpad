import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  applyBalanceDelta,
  creatorEarnings,
  creatorOverview,
  holderConcentration,
  listActivity,
  platformStats,
  tokenFeeSummary,
  tokenLifetime,
  updateLaunchMetadata,
  upsertTokenProfile,
  readTokenProfile,
  insertFeeEvent,
  insertLaunch,
  insertSwap,
  insertTransfer,
  listCandles,
  listHolders,
  listMarkets,
  listStocks,
  listSwaps,
  readCursor,
  readMarket,
  rebuildCandle,
  rollbackFrom,
  upsertBlock,
  upsertStockQuote,
  writeCursor,
} from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000aa';
const CREATOR = '0x1111111111111111111111111111111111111111';
const TRADER = '0x2222222222222222222222222222222222222222';
const POOL = `0x${'ab'.repeat(32)}`;

let db: Db;

beforeAll(async () => {
  db = await createEmbeddedDb();
  await migrate(db);
});

afterAll(async () => {
  await db.close();
});

describe('schema and seed', () => {
  it('seeds the thirteen Coinbase stocks', async () => {
    const stocks = await listStocks(db);
    expect(stocks).toHaveLength(13);
    expect(stocks.find((s) => s.symbol === 'NVDAc')?.address).toBe(NVDAc);
  });

  it('migrate is idempotent', async () => {
    await migrate(db);
    expect(await listStocks(db)).toHaveLength(13);
  });

  it('tracks the indexer cursor', async () => {
    expect(await readCursor(db)).toBeNull();
    await writeCursor(db, 100n, '0xabc');
    const cursor = await readCursor(db);
    expect(cursor?.next_block).toBe('100');
    expect(cursor?.last_block_hash).toBe('0xabc');
  });
});

describe('launches, swaps, candles, balances', () => {
  const launchedAt = new Date('2026-09-05T12:00:00Z');

  it('records a launch and reads it back as a market', async () => {
    await upsertBlock(db, { number: 50_900_000n, hash: '0xb1', parentHash: '0xb0', timestamp: launchedAt });
    await insertLaunch(db, {
      token: TOKEN,
      stock: NVDAc,
      creator: CREATOR,
      poolId: POOL,
      tokenIsCurrency0: false,
      name: 'Test Token',
      symbol: 'TEST',
      contractUri: 'ipfs://bafytest',
      openingSqrtPriceX96: 123n,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n,
      blockNumber: 50_900_000n,
      blockHash: '0xb1',
      txHash: '0xt1',
      logIndex: 3,
      launchedAt,
    });
    await upsertStockQuote(db, {
      stock: NVDAc,
      priceUsd8: 23_000_000_000n,
      feedUpdatedAt: launchedAt,
      observedAt: launchedAt,
      observedBlock: 50_900_000n,
    });
    const market = await readMarket(db, TOKEN);
    expect(market?.symbol).toBe('TEST');
    expect(market?.stock_symbol).toBe('NVDAc');
    expect(market?.stock_usd8).toBe('23000000000');
    expect(market?.last_price).toBeNull();
    expect(market?.holder_count).toBe(0);
    expect(await listMarkets(db, { stock: NVDAc })).toHaveLength(1);
    expect(await listMarkets(db, { search: 'tes' })).toHaveLength(1);
    expect(await listMarkets(db, { search: 'zzz' })).toHaveLength(0);
    expect(await listMarkets(db, { tokens: [TOKEN.toUpperCase()] })).toHaveLength(1);
    expect(await listMarkets(db, { tokens: [] })).toHaveLength(0);
  });

  it('records swaps and rebuilds the minute candle', async () => {
    const t0 = new Date('2026-09-05T12:01:10Z');
    const t1 = new Date('2026-09-05T12:01:40Z');
    const base = {
      token: TOKEN,
      poolId: POOL,
      sender: '0x3333333333333333333333333333333333333333',
      trader: TRADER,
      liquidity: 10n ** 20n,
      blockHash: '0xb2',
      feeStockRaw: 1_000_000n,
    };
    await insertSwap(db, {
      ...base,
      txHash: '0xs1',
      logIndex: 1,
      side: 'buy',
      amountTokenRaw: 1_000n * 10n ** 18n,
      amountStockRaw: 99_000_000n,
      priceTokenInStock: '0.000000021000000000000000000000',
      sqrtPriceX96: 456n,
      tick: 1,
      blockNumber: 50_900_010n,
      blockTime: t0,
    });
    await insertSwap(db, {
      ...base,
      txHash: '0xs2',
      logIndex: 1,
      side: 'sell',
      amountTokenRaw: 500n * 10n ** 18n,
      amountStockRaw: 40_000_000n,
      priceTokenInStock: '0.000000020000000000000000000000',
      sqrtPriceX96: 455n,
      tick: 0,
      blockNumber: 50_900_011n,
      blockTime: t1,
    });
    await rebuildCandle(db, TOKEN, new Date('2026-09-05T12:01:00Z'));
    const candles = await listCandles(db, TOKEN);
    expect(candles).toHaveLength(1);
    expect(candles[0]?.trade_count).toBe(2);
    expect(Number(candles[0]?.open)).toBeCloseTo(2.1e-8, 12);
    expect(Number(candles[0]?.close)).toBeCloseTo(2.0e-8, 12);
    expect(candles[0]?.volume_stock_raw).toBe('139000000');

    const swaps = await listSwaps(db, { token: TOKEN });
    expect(swaps.map((s) => s.tx_hash)).toEqual(['0xs2', '0xs1']);
    const market = await readMarket(db, TOKEN);
    expect(Number(market?.last_price)).toBeCloseTo(2.0e-8, 12);
  });

  it('derives balances from transfers', async () => {
    const t = new Date('2026-09-05T12:00:05Z');
    const mint = { txHash: '0xt1', logIndex: 1, token: TOKEN, from: '0x0000000000000000000000000000000000000000', to: '0xfac7', amountRaw: 10n ** 27n, blockNumber: 50_900_000n, blockTime: t };
    expect(await insertTransfer(db, mint)).toBe(true);
    expect(await insertTransfer(db, mint)).toBe(false);
    await applyBalanceDelta(db, TOKEN, '0xfac7', 10n ** 27n, 50_900_000n);
    await insertTransfer(db, { ...mint, txHash: '0xs1', logIndex: 2, from: '0xfac7', to: TRADER, amountRaw: 1_000n * 10n ** 18n, blockNumber: 50_900_010n });
    await applyBalanceDelta(db, TOKEN, '0xfac7', -(1_000n * 10n ** 18n), 50_900_010n);
    await applyBalanceDelta(db, TOKEN, TRADER, 1_000n * 10n ** 18n, 50_900_010n);
    const holders = await listHolders(db, TOKEN);
    expect(holders[0]?.holder).toBe('0xfac7');
    expect(holders[1]?.holder).toBe(TRADER);
    expect(holders[1]?.balance_raw).toBe((1_000n * 10n ** 18n).toString());
    const market = await readMarket(db, TOKEN);
    expect(market?.holder_count).toBe(2);
  });

  it('aggregates creator earnings from fee events', async () => {
    await insertFeeEvent(db, {
      txHash: '0xs1',
      logIndex: 0,
      poolId: POOL,
      token: TOKEN,
      stock: NVDAc,
      amountRaw: 1_000_000n,
      creatorRaw: 700_000n,
      platformRaw: 300_000n,
      feeBps: 100,
      blockNumber: 50_900_010n,
      blockTime: new Date('2026-09-05T12:01:10Z'),
    });
    const earnings = await creatorEarnings(db, CREATOR);
    expect(earnings).toEqual([{ token: TOKEN, stock: NVDAc, earned_raw: '700000' }]);
  });

  it('summarises fees, lifetime trading and the creator profile', async () => {
    const fees = await tokenFeeSummary(db, TOKEN);
    expect(fees).toMatchObject({ total_raw: '1000000', creator_raw: '700000', platform_raw: '300000', events: 1 });
    expect(fees.first_at).toBeInstanceOf(Date);

    const life = await tokenLifetime(db, TOKEN);
    expect(life.trades).toBe(2);
    // The 24h window is measured against the real clock, so only bound it by the lifetime figures.
    expect(life.trades_24h).toBeLessThanOrEqual(life.trades);
    expect(BigInt(life.volume_24h_stock_raw)).toBeLessThanOrEqual(BigInt(life.volume_stock_raw));
    expect(life.buys_24h + life.sells_24h).toBe(life.trades_24h);

    const conc = await holderConcentration(db, TOKEN, '0x498581ff718922c3f8e6a244956af099b2652b2b');
    expect(conc.holders).toBeGreaterThanOrEqual(1);
    expect(BigInt(conc.top10_raw)).toBeGreaterThan(0n);
    expect(conc.pool_raw).toBe('0');
    expect(conc.burned_raw).toBe('0');
    expect(life.buys).toBe(1);
    expect(life.sells).toBe(1);
    expect(life.unique_traders).toBe(1);
    expect(life.creator_trades).toBe(0);
    expect(BigInt(life.volume_stock_raw)).toBeGreaterThan(0n);

    const swaps = await listSwaps(db, { token: TOKEN });
    expect(swaps.every((s) => s.is_creator === false)).toBe(true);

    const creator = await creatorOverview(db, CREATOR);
    expect(creator.tokens).toBe(1);
    expect(creator.trades).toBe(2);
    expect(creator.fees_by_stock).toEqual([{ stock: NVDAc, symbol: 'NVDAc', decimals: 8, amount_raw: '700000' }]);
    expect(creator.volume_by_stock[0]?.stock).toBe(NVDAc);
    expect((await creatorOverview(db, TRADER)).tokens).toBe(0);
  });

  it('builds the activity feed and platform stats from launches and swaps', async () => {
    const feed = await listActivity(db, { limit: 10 });
    expect(feed.map((r) => r.kind)).toEqual(['swap', 'swap', 'launch']);
    expect(feed[2]).toMatchObject({ token: TOKEN, actor: CREATOR, is_creator: true, stock_symbol: 'NVDAc', stock_decimals: 8 });
    expect(feed[0]?.side).toBe('sell');
    expect(await listActivity(db, { actor: TRADER })).toHaveLength(2);
    expect(await listActivity(db, { token: '0x0000000000000000000000000000000000000001' })).toHaveLength(0);

    const stats = await platformStats(db);
    expect(stats.launches).toBe(1);
    expect(stats.creators).toBe(1);
    expect(stats.traders).toBe(1);
    expect(stats.swaps).toBe(2);
    expect(stats.fees_by_stock).toEqual([{ stock: NVDAc, symbol: 'NVDAc', decimals: 8, amount_raw: '1000000', creator_raw: '700000', platform_raw: '300000' }]);
    expect(stats.launches_by_stock).toEqual([{ stock: NVDAc, symbol: 'NVDAc', launches: 1 }]);
  });

  it('stores metadata including the X profile and seeds stock icons', async () => {
    await updateLaunchMetadata(db, TOKEN, { description: 'd', imageUri: 'ipfs://i', website: 'https://w', twitter: 'https://x.com/test' });
    const market = await readMarket(db, TOKEN);
    expect(market?.twitter).toBe('https://x.com/test');
    const stocks = await listStocks(db);
    expect(stocks.every((s) => s.image_uri?.startsWith('https://metadata.coinbase.com/equity_icons/'))).toBe(true);
  });

  it('stores creator-signed profiles that override launch metadata, never rolling back', async () => {
    const base = { token: TOKEN, description: 'new text', imageUri: null, website: 'https://new.example', twitter: null, telegram: 'https://t.me/test', signer: CREATOR, signature: '0xsig' };
    expect(await upsertTokenProfile(db, { ...base, issuedAt: new Date('2026-09-06T10:00:00Z') })).toBe(true);
    const market = await readMarket(db, TOKEN);
    expect(market?.profile_description).toBe('new text');
    expect(market?.profile_website).toBe('https://new.example');
    expect(market?.profile_telegram).toBe('https://t.me/test');
    expect(market?.description).toBe('d'); // launch metadata untouched
    // An older signed message must not replace a newer profile.
    expect(await upsertTokenProfile(db, { ...base, description: 'older', issuedAt: new Date('2026-09-06T09:00:00Z') })).toBe(false);
    expect((await readTokenProfile(db, TOKEN))?.description).toBe('new text');
    expect(await upsertTokenProfile(db, { ...base, description: 'newest', issuedAt: new Date('2026-09-06T11:00:00Z') })).toBe(true);
    expect((await readTokenProfile(db, TOKEN))?.description).toBe('newest');
  });

  it('rolls back a reorged range and restores balances', async () => {
    await rollbackFrom(db, 50_900_011n);
    const swaps = await listSwaps(db, { token: TOKEN });
    expect(swaps.map((s) => s.tx_hash)).toEqual(['0xs1']);
    const candles = await listCandles(db, TOKEN);
    expect(candles[0]?.trade_count).toBe(1);
    await rollbackFrom(db, 50_900_010n);
    expect(await listSwaps(db, { token: TOKEN })).toHaveLength(0);
    expect(await listCandles(db, TOKEN)).toHaveLength(0);
    const holders = await listHolders(db, TOKEN);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.balance_raw).toBe((10n ** 27n).toString());
    expect(await readMarket(db, TOKEN)).not.toBeNull();
    await rollbackFrom(db, 50_900_000n);
    expect(await readMarket(db, TOKEN)).toBeNull();
  });
});
