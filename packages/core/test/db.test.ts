import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  advanceIndexedDeployments,
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
  insertMetadataUpdates,
  insertSwap,
  insertTransfer,
  listCandles,
  listHolders,
  listMarkets,
  listStocks,
  listSwaps,
  listUnstampedLaunches,
  markDeploymentIndexed,
  readCursor,
  readIndexedDeployments,
  readMarket,
  rebuildCandle,
  rollbackFrom,
  stampLaunchDeployment,
  upsertBlock,
  upsertStockQuote,
  writeCursor,
} from '../src/db/queries';
import { quoteLaunchBuy } from '../src/launch-buy';
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
    await updateLaunchMetadata(db, TOKEN, { description: 'd', imageUri: 'ipfs://i', website: 'https://w', twitter: 'https://x.com/test' }, 'ipfs://bafytest');
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

// ---------------------------------------------------------------------------------------------
// Editable profiles, the creator buy at launch, and launches from several deployments. Each test
// gets its own database: rollbacks here delete by block and must not reach the rows above.
// ---------------------------------------------------------------------------------------------

const FACTORY_OLD = '0x888BC129704A4158C07614C234bb7EB8126aAD47';
const HOOK_OLD = '0xC81a728c6F4034e9249bB905f30E3013CA95E0Cc';
const FACTORY_NEW = '0x1000000000000000000000000000000000000001';
const HOOK_NEW = '0x20000000000000000000000000000000000000c8';
const EDITABLE = '0xb2000000000000000000000000000000000000e1';
const LAUNCH_TX = '0xlaunchtx';
const LAUNCH_BLOCK = 51_000_000n;
const LAUNCH_TIME = new Date('2026-10-01T12:00:00Z');

let fresh: Db;

async function freshDb(): Promise<Db> {
  const created = await createEmbeddedDb();
  await migrate(created);
  return created;
}

async function launchRow(token: string, options: { editable?: boolean; txHash?: string; uri?: string; deployment?: boolean } = {}) {
  await insertLaunch(fresh, {
    token,
    stock: NVDAc,
    creator: CREATOR,
    poolId: `0x${token.slice(-2).repeat(32)}`,
    tokenIsCurrency0: false,
    name: 'Editable',
    symbol: 'EDIT',
    contractUri: options.uri ?? 'ipfs://launch',
    openingSqrtPriceX96: 123n,
    tickLower: -887_200,
    tickUpper: 449_600,
    liquidity: 10n ** 20n,
    stockUsd8: 22_995_730_000n,
    blockNumber: LAUNCH_BLOCK,
    blockHash: '0xlb',
    txHash: options.txHash ?? LAUNCH_TX,
    logIndex: 5,
    launchedAt: LAUNCH_TIME,
    ...(options.editable === undefined ? {} : { metadataEditable: options.editable }),
    ...(options.deployment === false ? {} : { factory: FACTORY_NEW, hook: HOOK_NEW }),
  });
}

function uriUpdate(block: bigint, logIndex: number, contractUri: string, token = EDITABLE) {
  return {
    txHash: `0xu${block}`,
    logIndex,
    token,
    kind: 'uri' as const,
    contractUri,
    blockNumber: block,
    blockTime: new Date(Number(block - LAUNCH_BLOCK) * 2_000 + LAUNCH_TIME.getTime()),
  };
}

type FetchState = {
  current_contract_uri: string | null;
  metadata_fetched_at: Date | null;
  metadata_attempts: number;
  metadata_last_attempt_at: Date | null;
  metadata_locked_at: Date | null;
  description: string | null;
};

async function fetchState(token = EDITABLE): Promise<FetchState> {
  const [row] = await fresh.query<FetchState>(
    `SELECT current_contract_uri, metadata_fetched_at, metadata_attempts, metadata_last_attempt_at,
            metadata_locked_at, description FROM launches WHERE token = $1`,
    [token],
  );
  return row!;
}

/** What the metadata backfill leaves behind after a successful fetch of `uri`, plus a failed attempt count. */
async function markFetched(uri: string, token = EDITABLE) {
  expect(await updateLaunchMetadata(fresh, token, { description: `from ${uri}`, imageUri: null, website: null }, uri)).toBe(true);
  await fresh.query('UPDATE launches SET metadata_attempts = 2, metadata_last_attempt_at = now() WHERE token = $1', [token]);
}

describe('launch rows from several deployments', () => {
  beforeEach(async () => {
    fresh = await freshDb();
  });
  afterEach(async () => {
    await fresh.close();
  });

  it('round-trips the editable flag and the deployment, lowercased', async () => {
    await launchRow(EDITABLE, { editable: true });
    const market = await readMarket(fresh, EDITABLE);
    expect(market).toMatchObject({
      metadata_editable: true,
      metadata_locked_at: null,
      current_contract_uri: null,
      telegram: null,
      factory: FACTORY_NEW.toLowerCase(),
      hook: HOOK_NEW.toLowerCase(),
      profile_updates: 0,
      profile_updated_onchain_at: null,
    });
  });

  it('defaults a launch without the new fields to a fixed profile and no deployment yet', async () => {
    await launchRow(TOKEN, { deployment: false });
    const market = await readMarket(fresh, TOKEN);
    expect(market?.metadata_editable).toBe(false);
    expect(market?.factory).toBeNull();
    expect(market?.hook).toBeNull();
  });

  it('lists only the rows stored without their deployment, and stamps only those it is given', async () => {
    await launchRow(TOKEN, { deployment: false });
    await launchRow(EDITABLE, { txHash: '0xother' });
    expect(await listUnstampedLaunches(fresh)).toEqual([
      { token: TOKEN, creator: CREATOR, tx_hash: LAUNCH_TX, log_index: 5, block_number: LAUNCH_BLOCK.toString() },
    ]);
    // Nothing named, nothing written: the caller names each row it has matched on the chain.
    expect(await stampLaunchDeployment(fresh, { factory: FACTORY_OLD, hook: HOOK_OLD }, [])).toBe(0);
    expect(await stampLaunchDeployment(fresh, { factory: FACTORY_OLD, hook: HOOK_OLD }, [TOKEN.toUpperCase().replace('0X', '0x')])).toBe(1);
    expect(await readMarket(fresh, TOKEN)).toMatchObject({ factory: FACTORY_OLD.toLowerCase(), hook: HOOK_OLD.toLowerCase() });
    expect(await listUnstampedLaunches(fresh)).toEqual([]);
    // A deployment once recorded is never overwritten, even when a row is named again.
    expect(await stampLaunchDeployment(fresh, { factory: FACTORY_NEW, hook: HOOK_NEW }, [TOKEN, EDITABLE])).toBe(0);
    expect((await readMarket(fresh, TOKEN))?.hook).toBe(HOOK_OLD.toLowerCase());
    expect((await readMarket(fresh, EDITABLE))?.factory).toBe(FACTORY_NEW.toLowerCase());
  });

  it('records caught-up deployments and never moves one backwards', async () => {
    expect(await readIndexedDeployments(fresh)).toEqual([]);
    await markDeploymentIndexed(fresh, FACTORY_NEW, 51_000_100n);
    await markDeploymentIndexed(fresh, FACTORY_NEW, 51_000_050n);
    expect(await readIndexedDeployments(fresh)).toEqual([
      { factory: FACTORY_NEW.toLowerCase(), caught_up_through: '51000100' },
    ]);
  });

  it('moves a deployment on with the main pass only when nothing below the pass is missing', async () => {
    await markDeploymentIndexed(fresh, FACTORY_OLD, 51_000_099n);
    await markDeploymentIndexed(fresh, FACTORY_NEW, 51_000_049n); // a stretch nobody read for it
    // The one left behind is named, so the caller can catch it up now.
    expect(await advanceIndexedDeployments(fresh, [FACTORY_OLD, FACTORY_NEW, HOOK_NEW], 51_000_100n, 51_000_199n)).toEqual([
      FACTORY_NEW.toLowerCase(),
    ]);
    expect(await readIndexedDeployments(fresh)).toEqual([
      { factory: FACTORY_NEW.toLowerCase(), caught_up_through: '51000049' },
      { factory: FACTORY_OLD.toLowerCase(), caught_up_through: '51000199' },
    ]);
    // Never backwards, and no row is created for a deployment without a catch-up record.
    expect(await advanceIndexedDeployments(fresh, [FACTORY_OLD], 51_000_100n, 51_000_150n)).toEqual([]);
    expect((await readIndexedDeployments(fresh)).map((row) => row.caught_up_through)).toEqual(['51000049', '51000199']);
  });
});

describe('onchain profile updates', () => {
  beforeEach(async () => {
    fresh = await freshDb();
    await launchRow(EDITABLE, { editable: true });
  });
  afterEach(async () => {
    await fresh.close();
  });

  it('a uri update sets the current URI and restarts the fetch, keeping the old profile meanwhile', async () => {
    await markFetched('ipfs://launch');
    expect(await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://second')])).toBe(1);
    const state = await fetchState();
    expect(state).toMatchObject({
      current_contract_uri: 'ipfs://second',
      metadata_fetched_at: null,
      metadata_attempts: 0,
      metadata_last_attempt_at: null,
      description: 'from ipfs://launch',
    });
    // The launch value is never overwritten.
    expect((await readMarket(fresh, EDITABLE))?.contract_uri).toBe('ipfs://launch');

    // Re-indexing the same range inserts nothing and leaves a completed fetch alone.
    await markFetched('ipfs://second');
    expect(await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://second')])).toBe(0);
    expect((await fetchState()).metadata_fetched_at).not.toBeNull();
  });

  it('lets an onchain change restart a failing fetch at most once an hour', async () => {
    expect(await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://hangs')])).toBe(1);
    expect(await fetchState()).toMatchObject({ metadata_attempts: 0, metadata_last_attempt_at: null });
    // Its fetches keep failing.
    await fresh.query('UPDATE launches SET metadata_attempts = 3, metadata_last_attempt_at = now() WHERE token = $1', [EDITABLE]);

    // Re-sent a minute later, twice in one block: the new URI is queued, but the backoff stands, so
    // re-sending cannot keep a URI that never resolves at the front of the fetch queue.
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_040n, 0, 'ipfs://hangs'), uriUpdate(51_000_040n, 1, 'ipfs://hangs-too')]);
    const paced = await fetchState();
    expect(paced).toMatchObject({ current_contract_uri: 'ipfs://hangs-too', metadata_fetched_at: null, metadata_attempts: 3 });
    expect(paced.metadata_last_attempt_at).not.toBeNull();

    // After a quiet hour (1,800 blocks of 2 s), a real edit starts from scratch.
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_040n + 1_801n, 0, 'ipfs://fixed')]);
    expect(await fetchState()).toMatchObject({ current_contract_uri: 'ipfs://fixed', metadata_attempts: 0, metadata_last_attempt_at: null });
  });

  it('takes the latest URI of a batch whatever order it arrives in, and counts the changes', async () => {
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_020n, 1, 'ipfs://third'), uriUpdate(51_000_020n, 0, 'ipfs://second')]);
    expect((await fetchState()).current_contract_uri).toBe('ipfs://third');
    const market = await readMarket(fresh, EDITABLE);
    expect(market?.profile_updates).toBe(2);
    expect(market?.profile_updated_onchain_at).toEqual(uriUpdate(51_000_020n, 0, '').blockTime);
  });

  it('a lock stamps metadata_locked_at and is not a profile change', async () => {
    const lock = { txHash: '0xlock', logIndex: 3, token: EDITABLE, kind: 'lock' as const, contractUri: null, blockNumber: 51_000_030n, blockTime: new Date('2026-10-01T13:00:00Z') };
    expect(await insertMetadataUpdates(fresh, [lock])).toBe(1);
    const market = await readMarket(fresh, EDITABLE);
    expect(market?.metadata_locked_at).toEqual(lock.blockTime);
    expect(market?.profile_updates).toBe(0);
    expect(market?.current_contract_uri).toBeNull();
  });

  it('refuses a uri row without a URI', async () => {
    await expect(
      fresh.query(
        `INSERT INTO metadata_updates (tx_hash, log_index, token, kind, contract_uri, block_number, block_time)
         VALUES ('0xbad', 0, $1, 'uri', NULL, 1, now())`,
        [EDITABLE],
      ),
    ).rejects.toThrow();
  });

  it('a fetch of a URI that has since changed cannot overwrite the newer profile', async () => {
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://second')]);
    // The old document arrives late: the guarded UPDATE touches no row.
    expect(await updateLaunchMetadata(fresh, EDITABLE, { description: 'stale', imageUri: 'ipfs://old', website: null }, 'ipfs://launch')).toBe(false);
    expect((await fetchState()).description).toBeNull();
    expect((await fetchState()).metadata_fetched_at).toBeNull();
    // The current URI's fetch lands, telegram included.
    expect(
      await updateLaunchMetadata(fresh, EDITABLE, { description: 'new', imageUri: 'ipfs://new', website: null, telegram: 'https://t.me/edit' }, 'ipfs://second'),
    ).toBe(true);
    const market = await readMarket(fresh, EDITABLE);
    expect(market?.description).toBe('new');
    expect(market?.telegram).toBe('https://t.me/edit');
  });

  it('a rollback over an update restores the previous URI and forces a refetch', async () => {
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://second')]);
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_020n, 0, 'ipfs://third')]);
    await markFetched('ipfs://third');

    await rollbackFrom(fresh, 51_000_020n);
    expect(await fetchState()).toMatchObject({
      current_contract_uri: 'ipfs://second',
      metadata_fetched_at: null,
      metadata_attempts: 0,
      metadata_last_attempt_at: null,
    });
    expect((await readMarket(fresh, EDITABLE))?.profile_updates).toBe(1);

    // Back past the first change: the launch URI applies again.
    await rollbackFrom(fresh, 51_000_010n);
    expect((await fetchState()).current_contract_uri).toBeNull();
    expect((await readMarket(fresh, EDITABLE))?.profile_updates).toBe(0);
  });

  it('a rollback over a lock clears metadata_locked_at and keeps the URI', async () => {
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://second')]);
    await insertMetadataUpdates(fresh, [
      { txHash: '0xlock', logIndex: 0, token: EDITABLE, kind: 'lock', contractUri: null, blockNumber: 51_000_030n, blockTime: new Date('2026-10-01T13:00:00Z') },
    ]);
    await rollbackFrom(fresh, 51_000_030n);
    const state = await fetchState();
    expect(state.metadata_locked_at).toBeNull();
    expect(state.current_contract_uri).toBe('ipfs://second');
  });

  it('a rollback below the launch removes its updates along with it', async () => {
    await insertMetadataUpdates(fresh, [uriUpdate(51_000_010n, 0, 'ipfs://second')]);
    await rollbackFrom(fresh, LAUNCH_BLOCK);
    expect(await readMarket(fresh, EDITABLE)).toBeNull();
    expect(await fresh.query('SELECT 1 FROM metadata_updates')).toHaveLength(0);
  });
});

describe('the creator buy at launch', () => {
  beforeEach(async () => {
    fresh = await freshDb();
  });
  afterEach(async () => {
    await fresh.close();
  });

  const creatorSwap = (txHash: string, logIndex: number, trader: string, side: 'buy' | 'sell', q: { poolIn: bigint; fee: bigint; out: bigint }) => ({
    txHash,
    logIndex,
    token: EDITABLE,
    poolId: `0x${'e1'.repeat(32)}`,
    side,
    sender: FACTORY_NEW,
    trader,
    amountTokenRaw: q.out,
    amountStockRaw: q.poolIn,
    priceTokenInStock: '0.000000021',
    sqrtPriceX96: 1n,
    liquidity: 10n ** 20n,
    tick: 0,
    feeStockRaw: q.fee,
    blockNumber: LAUNCH_BLOCK,
    blockHash: '0xlb',
    blockTime: LAUNCH_TIME,
  });

  it('equals stockIn, the fee and tokensOut of the buy in the launch transaction', async () => {
    await launchRow(EDITABLE);
    // 100 NVDAc at a real opening tick, exactly as launchAndBuy would fill it.
    const stockIn = 100n * 10n ** 8n;
    const quote = quoteLaunchBuy({ openingTick: 449_612, tokenIsCurrency0: false, stockIn });
    // The PoolManager's Swap shows the pool side: stockIn less the hook's fee.
    await insertSwap(fresh, creatorSwap(LAUNCH_TX, 9, CREATOR, 'buy', { poolIn: stockIn - quote.fee, fee: quote.fee, out: quote.tokensOut }));
    // Neither a later creator buy nor anyone else's trade is part of it.
    await insertSwap(fresh, { ...creatorSwap('0xlater', 0, CREATOR, 'buy', { poolIn: 5n, fee: 1n, out: 7n }), blockNumber: LAUNCH_BLOCK + 1n });
    await insertSwap(fresh, { ...creatorSwap('0xother', 0, TRADER, 'buy', { poolIn: 5n, fee: 1n, out: 7n }), blockNumber: LAUNCH_BLOCK + 1n });

    const market = await readMarket(fresh, EDITABLE);
    expect(market?.creator_buy_stock_raw).toBe(stockIn.toString());
    expect(market?.creator_buy_fee_raw).toBe(quote.fee.toString());
    expect(market?.creator_buy_token_raw).toBe(quote.tokensOut.toString());
    expect(quote.fee).toBe(stockIn / 100n);
  });

  it('is NULL for a launch without one', async () => {
    await launchRow(EDITABLE);
    await insertSwap(fresh, { ...creatorSwap('0xlater', 0, CREATOR, 'buy', { poolIn: 5n, fee: 1n, out: 7n }), blockNumber: LAUNCH_BLOCK + 1n });
    const market = await readMarket(fresh, EDITABLE);
    expect(market?.creator_buy_stock_raw).toBeNull();
    expect(market?.creator_buy_fee_raw).toBeNull();
    expect(market?.creator_buy_token_raw).toBeNull();
    expect((await listMarkets(fresh, {}))[0]?.creator_buy_token_raw).toBeNull();
  });
});

describe('the activity feed image', () => {
  beforeEach(async () => {
    fresh = await freshDb();
  });
  afterEach(async () => {
    await fresh.close();
  });

  it('prefers a signed profile image for a fixed profile, and only the onchain one for an editable profile', async () => {
    const fixed = '0xb2000000000000000000000000000000000000f1';
    await launchRow(fixed, { txHash: '0xfixed' });
    await launchRow(EDITABLE, { editable: true });
    for (const token of [fixed, EDITABLE]) {
      await updateLaunchMetadata(fresh, token, { description: null, imageUri: `ipfs://onchain-${token.slice(-2)}`, website: null }, 'ipfs://launch');
      await upsertTokenProfile(fresh, {
        token, description: null, imageUri: `ipfs://signed-${token.slice(-2)}`, website: null, twitter: null, telegram: null,
        signer: CREATOR, signature: '0xsig', issuedAt: new Date('2026-10-01T12:30:00Z'),
      });
    }
    const feed = await listActivity(fresh, { limit: 10 });
    expect(feed.find((r) => r.token === fixed)?.image_uri).toBe('ipfs://signed-f1');
    expect(feed.find((r) => r.token === EDITABLE)?.image_uri).toBe('ipfs://onchain-e1');

    await insertSwap(fresh, {
      txHash: '0xswap', logIndex: 0, token: EDITABLE, poolId: `0x${'e1'.repeat(32)}`, side: 'buy', sender: FACTORY_NEW,
      trader: TRADER, amountTokenRaw: 1n, amountStockRaw: 1n, priceTokenInStock: '1', sqrtPriceX96: 1n,
      liquidity: 1n, tick: 0, feeStockRaw: 0n, blockNumber: LAUNCH_BLOCK + 1n, blockHash: '0xb', blockTime: new Date('2026-10-01T12:40:00Z'),
    });
    const swaps = await listActivity(fresh, { token: EDITABLE });
    expect(swaps.map((r) => [r.kind, r.image_uri])).toEqual([
      ['swap', 'ipfs://onchain-e1'],
      ['launch', 'ipfs://onchain-e1'],
    ]);
  });
});
