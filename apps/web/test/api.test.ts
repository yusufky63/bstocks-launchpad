import { sha256, stringToBytes } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';
import {
  SCHEMA_VERSION,
  createEmbeddedDb,
  insertFeeEvent,
  insertLaunch,
  insertMetadataUpdates,
  insertSwap,
  migrate,
  updateLaunchMetadata,
  upsertStockQuote,
  upsertTokenProfile,
  type Db,
  type MarketRow,
} from '@stockpair/core/db';

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
import { GET as getImage } from '@/app/api/tokens/[address]/image/route';
import { GET as getToken } from '@/app/api/tokens/[address]/route';
import { GET as getSwaps } from '@/app/api/tokens/[address]/swaps/route';
import { setDbForTests } from '@/lib/db.server';
import { publicEnv } from '@/lib/env';
import { appliedSchema, unknownLaunchHooks } from '@/lib/health.server';
import { effectiveImageUri, feedStatus, imageProxyUrl, imageVersion, isBareIpfsUri, launchedAgo, toMarketView, toProfileInfo } from '@/lib/market-view';
import { resetRateLimits } from '@/lib/rate-limit.server';
import { formatRatio, formatUsd, parse } from './helpers';

/**
 * The token's onchain contract URI, as the metadata route reads it. Tests never reach a chain: a
 * null here is a read that failed.
 */
const chain = vi.hoisted(() => ({ contractUri: null as string | null, reads: 0 }));
vi.mock('@/lib/onchain.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onchain.server')>()),
  readTokenContractUri: async () => {
    chain.reads += 1;
    if (chain.contractUri === null) throw new Error('no chain in tests');
    return chain.contractUri;
  },
}));

// Nothing here may reach Base. A smart-wallet signature check, for one, would otherwise send an
// eth_call to the public RPC whenever a signature does not recover offline.
vi.mock('@/lib/chain.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chain.server')>()),
  getPublicClient: () =>
    new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('no chain in tests');
        },
      },
    ),
}));

/** A CIDv1-shaped string: `bafy`, a tag, padded to the 59 characters Pinata's CIDs have. */
const cid = (tag: string) => `bafy${tag}${'a'.repeat(55 - tag.length)}`;

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
      contractUri: `ipfs://${cid('test')}`,
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
    // Old enough that we are pricing with a held reading -- which is not the same as the oracle
    // being paused, a claim the timestamp alone cannot support.
    expect(feedStatus(new Date(Date.now() - 5 * 60 * 60_000))).toBe('holding');
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
      telegram: null,
      metadata_editable: false,
      metadata_locked_at: null,
      current_contract_uri: null,
      factory: null,
      hook: null,
      creator_buy_stock_raw: null,
      creator_buy_fee_raw: null,
      creator_buy_token_raw: null,
      profile_updates: 0,
      profile_updated_onchain_at: null,
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

describe('launch and onchain profile in the token API', () => {
  const EDITABLE = '0xb2000000000000000000000000000000000000bb';
  const FACTORY = '0x1000000000000000000000000000000000000002';
  const HOOK = '0x2000000000000000000000000000000000000002';
  const LAUNCH_TX = `0x${'e1'.repeat(32)}`;
  const TOKENS_OUT = 43_500_000n * 10n ** 18n; // 4.35% of supply
  const IMAGE = `ipfs://${cid('image')}`;
  const LAUNCH_URI = `ipfs://${cid('launch')}`;

  beforeAll(async () => {
    await insertLaunch(db, {
      token: EDITABLE,
      stock: NVDAc,
      creator: CREATOR.address.toLowerCase(),
      poolId: `0x${'ee'.repeat(32)}`,
      tokenIsCurrency0: true,
      name: 'Editable Token',
      symbol: 'EDIT',
      contractUri: LAUNCH_URI,
      openingSqrtPriceX96: 117_000_000_000_000_000_000n,
      tickLower: -406_700,
      tickUpper: 887_200,
      liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n,
      blockNumber: 51_600_000n,
      blockHash: '0xb9',
      txHash: LAUNCH_TX,
      logIndex: 3,
      launchedAt: new Date(Date.now() - 10 * 60_000),
      metadataEditable: true,
      factory: FACTORY,
      hook: HOOK,
    });
    await updateLaunchMetadata(db, EDITABLE, { description: 'Onchain description', imageUri: IMAGE, website: null, telegram: 'https://t.me/editable' }, LAUNCH_URI);
    // The creator's buy inside the launch transaction.
    await insertSwap(db, {
      txHash: LAUNCH_TX,
      logIndex: 7,
      token: EDITABLE,
      poolId: `0x${'ee'.repeat(32)}`,
      side: 'buy',
      sender: FACTORY,
      trader: CREATOR.address.toLowerCase(),
      amountTokenRaw: TOKENS_OUT,
      amountStockRaw: 99_000_000n,
      priceTokenInStock: '0.000000022000000000000000000000',
      sqrtPriceX96: 456n,
      liquidity: 10n ** 20n,
      tick: 1,
      feeStockRaw: 1_000_000n,
      blockNumber: 51_600_000n,
      blockHash: '0xb9',
      blockTime: new Date(Date.now() - 10 * 60_000),
    });
    // A signed off-chain profile that must never apply to an editable token.
    await upsertTokenProfile(db, { token: EDITABLE, description: 'Signed text', imageUri: `ipfs://${cid('signed')}`, website: null, twitter: null, telegram: null, signer: CREATOR.address, signature: '0x', issuedAt: new Date() });
  });

  beforeEach(() => resetRateLimits());
  afterEach(() => vi.unstubAllGlobals());

  it('gives old tokens no creator buy and an immutable profile', async () => {
    const response = await parse(await getToken(new Request('http://x'), ctx(TOKEN)));
    expect(response.body.launch).toEqual({ factory: null, hook: null, creatorBuy: null });
    expect(response.body.profile).toMatchObject({ onchain: 'immutable', contractUri: `ipfs://${cid('test')}`, contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null });
  });

  it('reports the launch deployment and the creator buy at launch exactly', async () => {
    const response = await parse(await getToken(new Request('http://x'), ctx(EDITABLE)));
    expect(response.status).toBe(200);
    expect(response.body.launch).toEqual({
      factory: FACTORY,
      hook: HOOK,
      creatorBuy: { stockInRaw: '100000000', feeRaw: '1000000', tokensOutRaw: TOKENS_OUT.toString(), supplyBps: 435, txHash: LAUNCH_TX },
    });
    expect(response.body.market.factory).toBe(FACTORY);
    expect(response.body.market.hook).toBe(HOOK);
    expect(response.body.profile).toMatchObject({ onchain: 'editable', contractUri: LAUNCH_URI, contentAddressed: true, updates: 0 });
  });

  it('shows the onchain profile of an editable token, never the signed one', async () => {
    const { body } = await parse(await getToken(new Request('http://x'), ctx(EDITABLE)));
    expect(body.market.description).toBe('Onchain description');
    expect(body.market.telegram).toBe('https://t.me/editable');
    expect(body.market.profileUpdatedAt).toBeNull();
    // Absolute: other origins (the BStocks app) render it straight into an <img>.
    expect(body.market.imageUrl).toBe(`${publicEnv.appUrl}/api/tokens/${EDITABLE}/image?v=${imageVersion(IMAGE)}`);
    expect(body.market.imageUrl).toMatch(/^https?:\/\//u);
  });

  it('refuses a signed profile for an editable token with 409', async () => {
    const form = new FormData();
    form.set('payload', '{}');
    const refused = await parse(await postProfile(new Request('http://x', { method: 'POST', body: form }), ctx(EDITABLE)));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("This token's profile lives onchain; update it from the token page.");
  });

  /** Pinata stand-in that also serves one IPFS document from the gateway. Records every upload. */
  function stubPinata(document: Record<string, unknown> | null) {
    const uploads: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: FormData }) => {
      if (!init?.body) return document === null ? new Response('gone', { status: 404 }) : Response.json(document);
      const file = init.body.get('file') as Blob;
      uploads.push(file.type === 'application/json' ? (JSON.parse(await file.text()) as Record<string, unknown>) : { image: file.type });
      return Response.json({ data: { cid: cid(file.type === 'application/json' ? 'newdoc' : 'newimage') } });
    });
    return uploads;
  }

  async function withPinata<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.PINATA_JWT;
    process.env.PINATA_JWT = 'test-only';
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.PINATA_JWT;
      else process.env.PINATA_JWT = previous;
      chain.contractUri = null;
    }
  }

  const editForm = (image?: File) => {
    const form = new FormData();
    form.set('token', EDITABLE);
    form.set('name', 'Nvidia Official');
    form.set('symbol', 'NVDAC');
    form.set('description', 'New words');
    form.set('telegram', '@editable');
    if (image) form.set('image', image);
    return form;
  };
  const postEdit = async (image?: File) => parse(await postMetadata(new Request('http://x/api/metadata', { method: 'POST', body: editForm(image) })));

  it('pins an editable profile with the name and symbol from the launch, whatever the caller sends', async () => {
    // The token points onchain at a newer document than the indexed row: its image is the one kept.
    const onchainImage = `ipfs://${cid('onchainimage')}`;
    chain.contractUri = `ipfs://${cid('current')}`;
    const uploads = stubPinata({ name: 'Editable Token', image: onchainImage });
    await withPinata(async () => {
      const response = await postEdit();
      expect(response.status).toBe(200);
      expect(response.body.contractURI).toBe(`ipfs://${cid('newdoc')}`);
      expect(uploads).toEqual([expect.objectContaining({ name: 'Editable Token', symbol: 'EDIT', description: 'New words', telegram: 'https://t.me/editable', image: onchainImage })]);
    });
    expect(IMAGE).not.toBe(onchainImage);
  });

  it('asks for the image again, and pins nothing, when the current one cannot be kept', async () => {
    const cases: [string | null, Record<string, unknown> | null][] = [
      [null, { image: IMAGE }], // the token's contract URI could not be read
      [`ipfs://${cid('current')}`, null], // its document could not be fetched
      [`ipfs://${cid('current')}/../../ipns/k51`, { image: IMAGE }], // not a bare CID
      [`ipfs://${cid('current')}`, { image: 'https://example.com/logo.png' }], // a web image
      [`ipfs://${cid('current')}`, { image: `ipfs://${cid('dir')}/logo.png` }], // a path inside a CID
    ];
    for (const [contractUri, document] of cases) {
      chain.contractUri = contractUri;
      const uploads = stubPinata(document);
      await withPinata(async () => {
        const response = await postEdit();
        expect(response.status, String(contractUri)).toBe(409);
        expect(response.body.error.code).toBe('IMAGE_REQUIRED');
        expect(response.body.error.message).toMatch(/image/u);
      });
      expect(uploads, String(contractUri)).toEqual([]);
    }
  });

  it('keeps no image when the current document has none, and reads nothing when a new image is sent', async () => {
    chain.contractUri = `ipfs://${cid('current')}`;
    const withoutImage = stubPinata({ name: 'Editable Token' });
    await withPinata(async () => expect((await postEdit()).status).toBe(200));
    expect(withoutImage[0]).not.toHaveProperty('image');

    const reads = chain.reads;
    const uploads = stubPinata(null);
    await withPinata(async () => expect((await postEdit(new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }))).status).toBe(200));
    expect(chain.reads).toBe(reads);
    expect(uploads.at(-1)).toMatchObject({ image: `ipfs://${cid('newimage')}` });
  });

  it('pins nothing for fixed, unknown or malformed tokens', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('no upload expected');
    });
    const post = (token: string) => {
      const form = new FormData();
      form.set('token', token);
      return postMetadata(new Request('http://x/api/metadata', { method: 'POST', body: form }));
    };
    expect((await post(TOKEN)).status).toBe(409);
    expect((await post('0xb2000000000000000000000000000000000000cc')).status).toBe(404);
    expect((await post('nope')).status).toBe(400);
  });

  it('counts onchain profile changes and reports a lock', async () => {
    await insertMetadataUpdates(db, [
      { txHash: `0x${'f1'.repeat(32)}`, logIndex: 0, token: EDITABLE, kind: 'uri', contractUri: `ipfs://${cid('second')}`, blockNumber: 51_600_010n, blockTime: new Date('2026-09-20T10:00:00Z') },
    ]);
    invalidate();
    const changed = await parse(await getToken(new Request('http://x'), ctx(EDITABLE)));
    expect(changed.body.profile).toMatchObject({ onchain: 'editable', contractUri: `ipfs://${cid('second')}`, updates: 1, lastUpdatedAt: '2026-09-20T10:00:00.000Z', lockedAt: null });

    await insertMetadataUpdates(db, [
      { txHash: `0x${'f2'.repeat(32)}`, logIndex: 0, token: EDITABLE, kind: 'lock', contractUri: null, blockNumber: 51_600_020n, blockTime: new Date('2026-09-21T10:00:00Z') },
    ]);
    invalidate();
    const locked = await parse(await getToken(new Request('http://x'), ctx(EDITABLE)));
    expect(locked.body.profile).toMatchObject({ onchain: 'locked', lockedAt: '2026-09-21T10:00:00.000Z' });
    // Locked tokens stay on the onchain path: still no signed profile, and nothing more to pin.
    const form = new FormData();
    form.set('token', EDITABLE);
    expect((await postMetadata(new Request('http://x/api/metadata', { method: 'POST', body: form }))).status).toBe(409);
    expect((await postProfile(new Request('http://x', { method: 'POST', body: new FormData() }), ctx(EDITABLE))).status).toBe(409);
  });

  it('serves the image under a versioned URL that is cached for good only when current', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    const current = await getImage(new Request(`http://x/api/tokens/${EDITABLE}/image?v=${imageVersion(IMAGE)}`), ctx(EDITABLE));
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const stale = await getImage(new Request(`http://x/api/tokens/${EDITABLE}/image?v=000000000000`), ctx(EDITABLE));
    expect(stale.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    // The onchain image, not the signed one.
    expect(fetched.every((url) => url.endsWith(`/ipfs/${cid('image')}`))).toBe(true);
  });

  it('never caches a web image as immutable, and says its profile is not content-addressed', async () => {
    const WEB = '0xb2000000000000000000000000000000000000dd';
    const webImage = 'https://example.com/logo.png';
    const uri = `ipfs://${cid('web')}`;
    await insertLaunch(db, {
      token: WEB,
      stock: NVDAc,
      creator: CREATOR.address.toLowerCase(),
      poolId: `0x${'dd'.repeat(32)}`,
      tokenIsCurrency0: true,
      name: 'Web Image',
      symbol: 'WEB',
      contractUri: uri,
      openingSqrtPriceX96: 117_000_000_000_000_000_000n,
      tickLower: -406_700,
      tickUpper: 887_200,
      liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n,
      blockNumber: 51_600_100n,
      blockHash: '0xba',
      txHash: `0x${'e2'.repeat(32)}`,
      logIndex: 3,
      launchedAt: new Date(),
    });
    await updateLaunchMetadata(db, WEB, { description: null, imageUri: webImage, website: null }, uri);
    invalidate();
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
    const response = await getImage(new Request(`http://x/api/tokens/${WEB}/image?v=${imageVersion(webImage)}`), ctx(WEB));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    const token = await parse(await getToken(new Request('http://x'), ctx(WEB)));
    expect(token.body.profile.contentAddressed).toBe(false);
  });
});

describe('market view', () => {
  it('versions the image URL by the first 12 hex of sha256 of the image URI', () => {
    expect(imageVersion('ipfs://bafyimage')).toBe(sha256(stringToBytes('ipfs://bafyimage')).slice(2, 14));
    expect(imageVersion('ipfs://a')).not.toBe(imageVersion('ipfs://b'));
    expect(imageProxyUrl('0xABC', null)).toBeNull();
    expect(imageProxyUrl('0xABC', 'data:image/png;base64,xx')).toBeNull();
    expect(imageProxyUrl('0xABC', 'ipfs://a')).toBe(`${publicEnv.appUrl}/api/tokens/0xabc/image?v=${imageVersion('ipfs://a')}`);
  });

  it('treats only ipfs:// and a bare CID as content-addressed', () => {
    expect(isBareIpfsUri(`ipfs://${cid('x')}`)).toBe(true);
    expect(isBareIpfsUri('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
    for (const uri of [`ipfs://${cid('x')}/meta.json`, `ipfs://${cid('x')}/../../ipns/k51`, 'ipfs://%2e%2e/ipns/example.com', 'ipfs://short', 'https://example.com/a.json', `ipfs://${cid('x')}?a`, null, undefined, '']) {
      expect(isBareIpfsUri(uri), String(uri)).toBe(false);
    }
  });

  it('calls a profile content-addressed only when the link and the image shown both are', () => {
    const base = { current_contract_uri: null, contract_uri: `ipfs://${cid('doc')}`, metadata_editable: true, metadata_locked_at: new Date(), image_uri: `ipfs://${cid('img')}`, profile_image_uri: null, profile_updates: 0, profile_updated_onchain_at: null } as unknown as MarketRow;
    const info = (over: Partial<MarketRow>) => toProfileInfo({ ...base, ...over } as MarketRow);
    expect(info({}).contentAddressed).toBe(true);
    expect(info({ image_uri: null }).contentAddressed).toBe(true);
    expect(info({ image_uri: 'https://example.com/logo.png' }).contentAddressed).toBe(false);
    expect(info({ current_contract_uri: `ipfs://${cid('doc')}/../../ipns/k51` }).contentAddressed).toBe(false);
    expect(info({ image_uri: `ipfs://${cid('dir')}/../../ipns/k51/logo.png` }).contentAddressed).toBe(false);
    expect(info({ contract_uri: 'https://example.com/meta.json' }).contentAddressed).toBe(false);
    // Forms the first factory accepted that cannot change behind the URI: a path that stays under
    // its CID, an inline document, and no link at all.
    expect(info({ image_uri: `ipfs://${cid('dir')}/logo.png` }).contentAddressed).toBe(true);
    expect(info({ metadata_editable: false, metadata_locked_at: null, contract_uri: `ipfs://${cid('dir')}/meta.json` } as Partial<MarketRow>).contentAddressed).toBe(true);
    expect(info({ metadata_editable: false, metadata_locked_at: null, contract_uri: 'data:application/json;base64,e30=' } as Partial<MarketRow>).contentAddressed).toBe(true);
    expect(info({ metadata_editable: false, metadata_locked_at: null, contract_uri: '' } as Partial<MarketRow>).contentAddressed).toBe(true);
    // A fixed profile shows the signed image, so that is the one checked.
    expect(info({ metadata_editable: false, metadata_locked_at: null, profile_image_uri: 'https://example.com/signed.png' } as Partial<MarketRow>).contentAddressed).toBe(false);
  });

  it('merges the signed profile only for tokens without an editable profile', () => {
    expect(effectiveImageUri({ metadata_editable: false, image_uri: 'ipfs://launch', profile_image_uri: 'ipfs://signed' })).toBe('ipfs://signed');
    expect(effectiveImageUri({ metadata_editable: true, image_uri: 'ipfs://launch', profile_image_uri: 'ipfs://signed' })).toBe('ipfs://launch');
  });
});

describe('health checks', () => {
  it('reports the schema version the database has applied', async () => {
    expect(await appliedSchema(db)).toBe(SCHEMA_VERSION);
  });

  it('names launch hooks that no configured deployment covers', async () => {
    const EDIT_HOOK = '0x2000000000000000000000000000000000000002';
    expect(await unknownLaunchHooks(db, [])).toEqual([EDIT_HOOK]);
    expect(await unknownLaunchHooks(db, [EDIT_HOOK.toUpperCase().replace('0X', '0x')])).toEqual([]);
  });
});
