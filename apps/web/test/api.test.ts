import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';
import { createEmbeddedDb, insertFeeEvent, insertLaunch, insertSwap, migrate, upsertStockQuote, type Db } from '@stockpair/core/db';

import { invalidate } from '@/lib/cache.server';

import { GET as getMarkets } from '@/app/api/markets/route';
import { POST as postMetadata } from '@/app/api/metadata/route';
import { POST as postQuote } from '@/app/api/quote/route';
import { GET as getStocks } from '@/app/api/stocks/route';
import { GET as getStats } from '@/app/api/stats/route';
import { GET as getProfile, POST as postProfile } from '@/app/api/tokens/[address]/profile/route';
import { privateKeyToAccount } from 'viem/accounts';
import { EMPTY_IMAGE_HASH, PROFILE_DOMAIN, PROFILE_TYPES, buildProfileMessage } from '@/lib/profile';
import { GET as getActivity } from '@/app/api/activity/route';
import { GET as getCandles } from '@/app/api/tokens/[address]/candles/route';
import { GET as getHolders } from '@/app/api/tokens/[address]/holders/route';
import { GET as getToken } from '@/app/api/tokens/[address]/route';
import { GET as getSwaps } from '@/app/api/tokens/[address]/swaps/route';
import { setDbForTests } from '@/lib/db.server';
import { feedStatus, launchedAgo, toMarketView } from '@/lib/market-view';
import { formatRatio, formatUsd, parse } from './helpers';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000aa';
/** Deterministic test key; its address is the launch creator in the fixtures below. */
const CREATOR = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${'22'.repeat(32)}`);

let db: Db;

beforeAll(async () => {
  db = await createEmbeddedDb();
  await migrate(db);
  setDbForTests(db);
});

// Server reads are memoised for a few seconds; tests insert fixtures between calls, so start each one cold.
beforeEach(() => invalidate());

afterAll(async () => {
  setDbForTests(null);
  await db.close();
});

const ctx = (address: string) => ({ params: Promise.resolve({ address }) });

describe('read APIs on an empty database', () => {
  it('lists no markets and all thirteen stocks', async () => {
    const markets = await parse(await getMarkets(new Request('http://x/api/markets')));
    expect(markets.status).toBe(200);
    expect(markets.body.markets).toEqual([]);
    const stocks = await parse(await getStocks());
    expect(stocks.body.stocks).toHaveLength(13);
    expect(stocks.body.stocks[0].feedStatus).toBe('unknown');
  });

  it('rejects malformed addresses and unknown tokens', async () => {
    expect((await getToken(new Request('http://x'), ctx('nope'))).status).toBe(400);
    expect((await getSwaps(new Request('http://x/api/tokens/x/swaps'), ctx(TOKEN))).status).toBe(404);
    expect((await getCandles(new Request('http://x/api/tokens/x/candles'), ctx(TOKEN))).status).toBe(404);
    expect((await getHolders(new Request('http://x/api/tokens/x/holders'), ctx(TOKEN))).status).toBe(404);
  });

  it('validates quote requests', async () => {
    const bad = await postQuote(new Request('http://x/api/quote', { method: 'POST', body: '{' }));
    expect(bad.status).toBe(400);
    const missing = await postQuote(
      new Request('http://x/api/quote', { method: 'POST', body: JSON.stringify({ token: TOKEN, side: 'buy', amountIn: '0' }) }),
    );
    expect(missing.status).toBe(400);
  });

  it('validates metadata uploads and reports missing Pinata configuration', async () => {
    const form = new FormData();
    form.set('name', 'Test');
    form.set('symbol', 'bad symbol');
    const invalid = await postMetadata(new Request('http://x/api/metadata', { method: 'POST', body: form }));
    expect(invalid.status).toBe(400);
    const ok = new FormData();
    ok.set('name', 'Test');
    ok.set('symbol', 'TEST');
    const previous = process.env.PINATA_JWT;
    delete process.env.PINATA_JWT;
    const unconfigured = await postMetadata(new Request('http://x/api/metadata', { method: 'POST', body: ok }));
    expect(unconfigured.status).toBe(503);
    if (previous) process.env.PINATA_JWT = previous;
  });
});

describe('read APIs with one indexed launch', () => {
  beforeAll(async () => {
    const launchedAt = new Date(Date.now() - 90 * 60_000);
    await insertLaunch(db, {
      token: TOKEN,
      stock: NVDAc,
      creator: CREATOR.address.toLowerCase(),
      poolId: `0x${'cd'.repeat(32)}`,
      tokenIsCurrency0: true,
      name: 'Test Token',
      symbol: 'TEST',
      contractUri: 'ipfs://bafytest',
      openingSqrtPriceX96: 117_000_000_000_000_000_000n,
      tickLower: -406_700,
      tickUpper: 887_200,
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
      feedUpdatedAt: new Date(),
      observedAt: new Date(),
      observedBlock: 50_900_100n,
    });
    await insertSwap(db, {
      txHash: '0xs1',
      logIndex: 1,
      token: TOKEN,
      poolId: `0x${'cd'.repeat(32)}`,
      side: 'buy',
      sender: '0x3333333333333333333333333333333333333333',
      trader: '0x2222222222222222222222222222222222222222',
      amountTokenRaw: 1_000n * 10n ** 18n,
      amountStockRaw: 99_000_000n,
      priceTokenInStock: '0.000000021000000000000000000000',
      sqrtPriceX96: 456n,
      liquidity: 10n ** 20n,
      tick: 1,
      feeStockRaw: 1_000_000n,
      blockNumber: 50_900_050n,
      blockHash: '0xb2',
      blockTime: new Date(Date.now() - 30 * 60_000),
    });
  });

  it('returns the market with derived USD numbers', async () => {
    const response = await parse(await getToken(new Request('http://x'), ctx(TOKEN)));
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('indexed');
    expect(response.body.details.pool).toBeNull(); // no contracts configured in tests: no live pool read
    expect(response.body.details.fees.events).toBe(0);
    expect(response.body.details.lifetime.trades).toBe(1);
    // Market links are keyed by the pool, never the token: a token-keyed page lists the pools
    // strangers opened against USDC or ETH beside ours.
    const poolId = `0x${'cd'.repeat(32)}`;
    expect(response.body.details.links.dexscreener).toBe(`https://dexscreener.com/base/${poolId}`);
    expect(response.body.details.links.geckoterminal).toBe(`https://www.geckoterminal.com/base/pools/${poolId}`);
    expect(response.body.details.links.uniswap).toBe(`https://app.uniswap.org/explore/pools/base/${poolId}`);
    expect(response.body.details.links.basescan).toBe(`https://basescan.org/token/${TOKEN}`);
    const market = response.body.market;
    expect(market.symbol).toBe('TEST');
    expect(market.stock.symbol).toBe('NVDAc');
    expect(market.stockUsd).toBe(230);
    expect(market.priceInStock).toBeCloseTo(2.1e-8, 12);
    expect(market.priceUsd).toBeCloseTo(2.1e-8 * 230, 12);
    expect(market.fdvUsd).toBeCloseTo(2.1e-8 * 230 * 1e9, 3);
    expect(market.volume24hStock).toBeCloseTo(0.99, 6);
    expect(market.volume24hUsd).toBeCloseTo(0.99 * 230, 6);
    expect(market.trades24h).toBe(1);
    expect(market.stockFeedStatus).toBe('live');
    expect(market.change24hPercent).toBeNull();
  });

  it('lists markets, filters by stock and search', async () => {
    const all = await parse(await getMarkets(new Request('http://x/api/markets')));
    expect(all.body.markets).toHaveLength(1);
    const byStock = await parse(await getMarkets(new Request(`http://x/api/markets?stock=${NVDAc}`)));
    expect(byStock.body.markets).toHaveLength(1);
    const other = await parse(await getMarkets(new Request(`http://x/api/markets?stock=${BASE_STOCKS[1]!.address}`)));
    expect(other.body.markets).toHaveLength(0);
    const search = await parse(await getMarkets(new Request('http://x/api/markets?q=zzz')));
    expect(search.body.markets).toHaveLength(0);
    const invalid = await getMarkets(new Request('http://x/api/markets?stock=nope'));
    expect(invalid.status).toBe(400);
  });

  it('serves swaps, candles and holders', async () => {
    const swaps = await parse(await getSwaps(new Request('http://x/api/tokens/x/swaps?limit=10'), ctx(TOKEN)));
    expect(swaps.body.swaps).toHaveLength(1);
    expect(swaps.body.swaps[0]).toMatchObject({ side: 'buy', amountToken: 1000, amountStock: 0.99, feeStock: 0.01 });
    expect(swaps.body.swaps[0].amountUsd).toBeCloseTo(0.99 * 230, 6);
    const candles = await parse(await getCandles(new Request('http://x/api/tokens/x/candles'), ctx(TOKEN)));
    expect(candles.body.candles).toEqual([]); // candles are rebuilt by the indexer, not by inserts
    const holders = await parse(await getHolders(new Request('http://x/api/tokens/x/holders'), ctx(TOKEN)));
    expect(holders.body.holders).toEqual([]);
    expect(holders.body.holderCount).toBe(0);
  });
});

describe('market view helpers', () => {
  it('reports platform stats and the activity feed in USD', async () => {
    await insertFeeEvent(db, {
      txHash: '0xfee1',
      logIndex: 0,
      poolId: '0x2',
      token: TOKEN,
      stock: NVDAc,
      amountRaw: 1_000_000n,
      creatorRaw: 700_000n,
      platformRaw: 300_000n,
      feeBps: 100,
      blockNumber: 50_900_010n,
      blockTime: new Date(),
    });
    invalidate();
    const stats = await parse(await getStats());
    expect(stats.status).toBe(200);
    expect(stats.body.launches).toBe(1);
    expect(stats.body.swaps).toBe(1);
    expect(stats.body.feesByStock).toHaveLength(1);
    expect(stats.body.creatorFeesUsd).toBeCloseTo(0.007 * 230, 3); // 0.007 NVDAc at $230
    const feed = await parse(await getActivity(new Request('http://x/api/activity?limit=10')));
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((i: { kind: string }) => i.kind)).toEqual(['swap', 'launch']);
    expect(feed.body.items[1].isCreator).toBe(true);
    expect((await getActivity(new Request('http://x/api/activity?actor=nope'))).status).toBe(400);
  });

  it('accepts a creator-signed profile and rejects strangers, stale and mismatched updates', async () => {
    const sign = async (account: typeof CREATOR, fields: { description: string; website: string; twitter: string; telegram: string }, issuedAt: bigint, imageHash = EMPTY_IMAGE_HASH) => {
      const { message, error } = buildProfileMessage({ token: TOKEN, ...fields, imageHash, issuedAt });
      if (error) throw new Error(error);
      const signature = await account.signTypedData({ domain: PROFILE_DOMAIN, types: PROFILE_TYPES, primaryType: 'TokenProfile', message });
      const form = new FormData();
      form.set('payload', JSON.stringify({ signer: account.address, signature, description: message.description, website: message.website, twitter: message.twitter, telegram: message.telegram, imageHash, issuedAt: Number(issuedAt) }));
      return form;
    };
    const now = BigInt(Math.floor(Date.now() / 1000));
    const fields = { description: 'Signed by the creator', website: 'https://stockpair.example', twitter: '@stockpair', telegram: 't.me/stockpair' };

    const ok = await parse(await postProfile(new Request('http://x', { method: 'POST', body: await sign(CREATOR, fields, now) }), ctx(TOKEN)));
    expect(ok.status).toBe(200);
    expect(ok.body.updated).toBe(true);
    const stored = await parse(await getProfile(new Request('http://x'), ctx(TOKEN)));
    expect(stored.body.profile.twitter).toBe('https://x.com/stockpair');
    expect(stored.body.profile.telegram).toBe('https://t.me/stockpair');
    invalidate();
    const token = await parse(await getToken(new Request('http://x'), ctx(TOKEN)));
    expect(token.body.market.description).toBe('Signed by the creator');
    expect(token.body.market.telegram).toBe('https://t.me/stockpair');
    expect(token.body.market.profileUpdatedAt).not.toBeNull();

    const stranger = await postProfile(new Request('http://x', { method: 'POST', body: await sign(STRANGER, fields, now + 1n) }), ctx(TOKEN));
    expect(stranger.status).toBe(403);
    const stale = await postProfile(new Request('http://x', { method: 'POST', body: await sign(CREATOR, fields, now - 1n) }), ctx(TOKEN));
    expect(stale.status).toBe(409);
    const expired = await postProfile(new Request('http://x', { method: 'POST', body: await sign(CREATOR, fields, now + 3_600n) }), ctx(TOKEN));
    expect(expired.status).toBe(400);
    const badImage = await postProfile(new Request('http://x', { method: 'POST', body: await sign(CREATOR, fields, now + 2n, `0x${'ab'.repeat(32)}`) }), ctx(TOKEN));
    expect(badImage.status).toBe(400);
    // Tampered field after signing: the signature no longer matches.
    const tampered = await sign(CREATOR, fields, now + 3n);
    const payload = JSON.parse(String(tampered.get('payload')));
    payload.description = 'tampered';
    tampered.set('payload', JSON.stringify(payload));
    const forged = await postProfile(new Request('http://x', { method: 'POST', body: tampered }), ctx(TOKEN));
    expect(forged.status).toBe(401);
  });

  it('classifies feed freshness', () => {
    expect(feedStatus(null)).toBe('unknown');
    expect(feedStatus(new Date())).toBe('live');
    expect(feedStatus(new Date(Date.now() - 5 * 60 * 60_000))).toBe('paused');
  });

  it('formats launch age and prices', () => {
    expect(launchedAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(launchedAgo(new Date(Date.now() - 3 * 60 * 60_000).toISOString())).toBe('3h ago');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0.000005)).toBe('$0.00000500');
    expect(formatUsd(null)).toBe('—');
    expect(formatRatio(2.1e-8, 'NVDAc')).toBe('2.100e-8 NVDAc');
  });

  it('never invents a price when the pool has no trades', () => {
    const view = toMarketView({
      token: TOKEN,
      stock: NVDAc,
      creator: '0x1',
      pool_id: '0x2',
      token_is_currency0: true,
      name: 'X',
      symbol: 'X',
      contract_uri: '',
      description: null,
      image_uri: null,
      website: null,
      twitter: null,
      profile_description: null,
      profile_image_uri: null,
      profile_website: null,
      profile_twitter: null,
      profile_telegram: null,
      profile_updated_at: null,
      opening_sqrt_price_x96: '1',
      tick_lower: 0,
      tick_upper: 1,
      liquidity: '1',
      stock_usd8_at_launch: '1',
      block_number: '1',
      block_hash: '0x',
      tx_hash: '0x',
      log_index: 0,
      launched_at: new Date(),
      metadata_fetched_at: null,
      stock_symbol: 'NVDAc',
      stock_ticker: 'NVDA',
      stock_decimals: 8,
      stock_usd8: null,
      feed_updated_at: null,
      last_price: null,
      last_trade_at: null,
      price_24h_ago: null,
      volume_24h_stock_raw: '0',
      volume_all_stock_raw: '0',
      trades_all: 0,
      trades_24h: 0,
      holder_count: 0,
    });
    expect(view.priceInStock).toBeNull();
    expect(view.priceUsd).toBeNull();
    expect(view.fdvUsd).toBeNull();
    expect(view.stockFeedStatus).toBe('unknown');
  });
});
