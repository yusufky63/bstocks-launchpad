import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type AbiParameter, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BASE_CONTRACTS,
  BASE_STOCKS,
  ERC20_TRANSFER_TOPIC,
  stockPairFactoryAbi,
  stockPairHookAbi,
  UNISWAP_V4_SWAP_TOPIC,
  type RawLog,
} from '@stockpair/core';
import {
  createEmbeddedDb,
  listStocks,
  listCandles,
  listHolders,
  listSwaps,
  migrate,
  readCursor,
  readMarket,
  type Db,
} from '@stockpair/core/db';

import type { ChainReader } from '../src/chain-reader';
import { fetchMetadata, gatewayUrl, normalizeTwitter, parseMetadata } from '../src/metadata';
import { refreshStockQuotes } from '../src/quotes';
import { syncOnce } from '../src/sync';

const FACTORY = '0x00000000000000000000000000000000000000f1' as Address;
const HOOK = '0x00000000000000000000000000000000000000c4' as Address;
const ROUTER = '0x00000000000000000000000000000000000000e0' as Address;
const NVDAc = BASE_STOCKS[0]!.address as Address;
const TOKEN = '0xb2000000000000000000000000000000000000aa' as Address; // sorts before NVDAc (…0000aa < …78ee…), so the token is currency0
const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const TRADER = '0x2222222222222222222222222222222222222222' as Address;
const POOL_ID = `0x${'cd'.repeat(32)}` as Hex;
const DEPLOY_BLOCK = 1_000n;

type Block = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };

/** In-memory Base: blocks with deterministic hashes, plus logs by block. */
class FakeChain implements ChainReader {
  head = 1_000n;
  logs = new Map<bigint, RawLog[]>();
  hashSalt = new Map<bigint, string>();
  senders = new Map<Hex, Address>();
  feeds = new Map<string, { answer: bigint; updatedAt: bigint }>();

  hashOf(number: bigint): Hex {
    return keccak256(toHex(`block-${number}-${this.hashSalt.get(number) ?? ''}`));
  }

  async getBlockNumber() {
    return this.head;
  }

  async getBlock(number: bigint): Promise<Block> {
    return {
      number,
      hash: this.hashOf(number),
      parentHash: this.hashOf(number - 1n),
      timestamp: 1_757_000_000n + number * 2n,
    };
  }

  async getLogs(filter: { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }) {
    const addresses = filter.address
      ? (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase())
      : null;
    const out: RawLog[] = [];
    for (let n = filter.fromBlock; n <= filter.toBlock; n += 1n) {
      for (const log of this.logs.get(n) ?? []) {
        if (addresses && !addresses.includes(log.address.toLowerCase())) continue;
        if (filter.topics) {
          let ok = true;
          filter.topics.forEach((topic, index) => {
            if (topic === null) return;
            const actual = log.topics[index];
            if (Array.isArray(topic)) {
              if (!actual || !topic.map((t) => t.toLowerCase()).includes(actual.toLowerCase())) ok = false;
            } else if (actual?.toLowerCase() !== topic.toLowerCase()) ok = false;
          });
          if (!ok) continue;
        }
        out.push({ ...log, blockHash: this.hashOf(n) });
      }
    }
    return out;
  }

  async getTransactionSender(hash: Hex) {
    return this.senders.get(hash) ?? null;
  }

  enabledOverrides = new Map<string, boolean>();
  async readStockEnabled(_factory: Address, stock: Address) {
    return this.enabledOverrides.get(stock.toLowerCase()) ?? true;
  }
  async readFeed(feed: Address) {
    return this.feeds.get(feed.toLowerCase()) ?? null;
  }

  add(block: bigint, log: Omit<RawLog, 'blockNumber' | 'blockHash'>) {
    const list = this.logs.get(block) ?? [];
    list.push({ ...log, blockNumber: block, blockHash: this.hashOf(block) });
    this.logs.set(block, list);
  }
}

function eventInputs(abi: readonly unknown[], name: string) {
  const event = abi.find((i) => (i as { type: string; name?: string }).type === 'event' && (i as { name?: string }).name === name) as {
    inputs: readonly (AbiParameter & { indexed?: boolean })[];
  };
  return event;
}

function launchedLog(sqrtPriceX96: bigint, txHash: Hex, logIndex: number): Omit<RawLog, 'blockNumber' | 'blockHash'> {
  const event = eventInputs(stockPairFactoryAbi, 'Launched');
  const topics = encodeEventTopics({
    abi: stockPairFactoryAbi,
    eventName: 'Launched',
    args: { token: TOKEN, creator: CREATOR, stock: NVDAc },
  });
  const data = encodeAbiParameters(event.inputs.filter((i) => !i.indexed), [
    POOL_ID,
    sqrtPriceX96,
    -887_200,
    100,
    10n ** 20n,
    22_995_730_000n,
    'Test Token',
    'TEST',
    'ipfs://bafytest',
  ]);
  return { address: FACTORY, topics: topics as [Hex, ...Hex[]], data, transactionHash: txHash, logIndex };
}

function swapLog(amount0: bigint, amount1: bigint, sqrtPriceX96: bigint, txHash: Hex, logIndex: number): Omit<RawLog, 'blockNumber' | 'blockHash'> {
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [amount0, amount1, sqrtPriceX96, 10n ** 20n, 5, 0],
  );
  return {
    address: BASE_CONTRACTS.poolManager,
    topics: [UNISWAP_V4_SWAP_TOPIC, POOL_ID, `0x000000000000000000000000${ROUTER.slice(2)}` as Hex],
    data,
    transactionHash: txHash,
    logIndex,
  };
}

function transferLog(token: Address, from: Address, to: Address, value: bigint, txHash: Hex, logIndex: number): Omit<RawLog, 'blockNumber' | 'blockHash'> {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, `0x000000000000000000000000${from.slice(2)}` as Hex, `0x000000000000000000000000${to.slice(2)}` as Hex],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    transactionHash: txHash,
    logIndex,
  };
}

function feeLog(amount: bigint, txHash: Hex, logIndex: number): Omit<RawLog, 'blockNumber' | 'blockHash'> {
  const event = eventInputs(stockPairHookAbi, 'FeeCharged');
  const topics = encodeEventTopics({ abi: stockPairHookAbi, eventName: 'FeeCharged', args: { poolId: POOL_ID, stock: NVDAc } });
  const creator = (amount * 7_000n) / 10_000n;
  const data = encodeAbiParameters(event.inputs.filter((i) => !i.indexed), [amount, creator, amount - creator, 100n]);
  return { address: HOOK, topics: topics as [Hex, ...Hex[]], data, transactionHash: txHash, logIndex };
}

const TOKEN_IS_CURRENCY0 = TOKEN.toLowerCase() < NVDAc.toLowerCase();
// token as currency0: raw stock per raw token ~ 2.2e-18 -> sqrtPriceX96 ~ 1.17e20
const OPENING_SQRT = 117_000_000_000_000_000_000n;
/** Swap event amounts in (amount0, amount1) order for a given token/stock delta. */
function amounts(tokenDelta: bigint, stockDelta: bigint): [bigint, bigint] {
  return TOKEN_IS_CURRENCY0 ? [tokenDelta, stockDelta] : [stockDelta, tokenDelta];
}

let db: Db;
let chain: FakeChain;
const deployment = { factory: FACTORY, hook: HOOK, router: ROUTER, deployBlock: DEPLOY_BLOCK };

beforeAll(async () => {
  db = await createEmbeddedDb();
  await migrate(db);
  chain = new FakeChain();
});

afterAll(async () => {
  await db.close();
});

const sync = () => syncOnce({ db, chain, deployment, confirmations: 6, maxRange: 50 });

describe('syncOnce', () => {
  it('is idle until the deploy block is confirmed', async () => {
    chain.head = 1_003n;
    const result = await sync();
    expect(result.status).toBe('idle');
    expect(await readCursor(db)).toBeNull();
  });

  it('indexes a launch, the mint transfer, a buy swap and its fee in one pass', async () => {
    expect(TOKEN_IS_CURRENCY0).toBe(true);
    const launchTx = '0xaaaa000000000000000000000000000000000000000000000000000000000001' as Hex;
    const buyTx = '0xbbbb000000000000000000000000000000000000000000000000000000000002' as Hex;
    chain.add(1_010n, transferLog(TOKEN, '0x0000000000000000000000000000000000000000', FACTORY, 10n ** 27n, launchTx, 0));
    chain.add(1_010n, transferLog(TOKEN, FACTORY, BASE_CONTRACTS.poolManager, 10n ** 27n - 5n, launchTx, 1));
    chain.add(1_010n, transferLog(TOKEN, FACTORY, '0x000000000000000000000000000000000000dEaD', 5n, launchTx, 2));
    chain.add(1_010n, launchedLog(OPENING_SQRT, launchTx, 3));
    // buy: swapper pays 1e8 stock, receives 1e24 token
    chain.add(1_012n, feeLog(1_000_000n, buyTx, 4));
    chain.add(1_012n, swapLog(...amounts(10n ** 24n, -99_000_000n), OPENING_SQRT + 1_000n, buyTx, 5));
    chain.add(1_012n, transferLog(TOKEN, BASE_CONTRACTS.poolManager, TRADER, 10n ** 24n, buyTx, 6));
    chain.senders.set(buyTx, TRADER);
    chain.head = 1_030n;

    const result = await sync();
    expect(result).toMatchObject({ status: 'progressed', fromBlock: 1_000n, toBlock: 1_024n, launches: 1, swaps: 1, transfers: 4 });

    const market = await readMarket(db, TOKEN);
    expect(market?.symbol).toBe('TEST');
    expect(market?.token_is_currency0).toBe(TOKEN_IS_CURRENCY0);
    expect(market?.holder_count).toBe(2); // pool manager and trader (dead sink excluded)
    expect(market?.trades_24h).toBe(0); // fake block time is in 2025 relative to now()

    const swaps = await listSwaps(db, { token: TOKEN });
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({ side: 'buy', trader: TRADER, amount_token_raw: (10n ** 24n).toString(), amount_stock_raw: '99000000', fee_stock_raw: '1000000' });
    expect(Number(swaps[0]!.price_token_in_stock)).toBeGreaterThan(0);

    const candles = await listCandles(db, TOKEN);
    expect(candles).toHaveLength(1);
    expect(candles[0]?.trade_count).toBe(1);

    const holders = await listHolders(db, TOKEN);
    expect(holders.map((h) => h.holder)).toEqual([BASE_CONTRACTS.poolManager.toLowerCase(), TRADER, '0x000000000000000000000000000000000000dead']);

    const cursor = await readCursor(db);
    expect(cursor?.next_block).toBe('1025');
    expect(cursor?.last_block_hash).toBe(chain.hashOf(1_024n));
  });

  it('continues from the cursor and is idle when caught up', async () => {
    const result = await sync();
    expect(result).toMatchObject({ status: 'idle', nextBlock: 1_025n, safeBlock: 1_024n });
  });

  it('detects a reorg of the last block, rolls back and re-indexes', async () => {
    const sellTx = '0xcccc000000000000000000000000000000000000000000000000000000000003' as Hex;
    chain.add(1_024n, swapLog(...amounts(-(5n * 10n ** 23n), 40_000_000n), OPENING_SQRT - 500n, sellTx, 1));
    chain.add(1_024n, transferLog(TOKEN, TRADER, BASE_CONTRACTS.poolManager, 5n * 10n ** 23n, sellTx, 2));
    chain.senders.set(sellTx, TRADER);
    chain.head = 1_040n;
    // First: a normal step that indexes block 1024's sell (it was in the last range? no: 1024 was already processed
    // without the sell). Simulate a reorg by changing 1024's hash so the indexer re-processes it.
    chain.hashSalt.set(1_024n, 'reorged');
    const reorg = await sync();
    // Blocks are stored sparsely (only those with logs), so the ancestor search lands on the last
    // stored block that still matches (1012) and the indexer conservatively re-processes from 1013.
    expect(reorg).toMatchObject({ status: 'reorg', rolledBackTo: 1_013n });
    expect(await listSwaps(db, { token: TOKEN })).toHaveLength(1); // buy at 1012 survives

    const progressed = await sync();
    expect(progressed).toMatchObject({ status: 'progressed', fromBlock: 1_013n, toBlock: 1_034n, swaps: 1, transfers: 1 });
    const swaps = await listSwaps(db, { token: TOKEN });
    expect(swaps).toHaveLength(2);
    expect(swaps[0]).toMatchObject({ side: 'sell', amount_stock_raw: '40000000', amount_token_raw: (5n * 10n ** 23n).toString() });
    const holders = await listHolders(db, TOKEN);
    expect(holders.find((h) => h.holder === TRADER)?.balance_raw).toBe((5n * 10n ** 23n).toString());
    expect((await readCursor(db))?.last_block_hash).toBe(chain.hashOf(1_034n));
  });
});

describe('stock quotes', () => {
  it('stores Chainlink readings for enabled stocks', async () => {
    chain.feeds.set(BASE_STOCKS[0]!.feed.toLowerCase(), { answer: 22_995_730_000n, updatedAt: 1_757_000_000n });
    chain.enabledOverrides.set(NVDAc.toLowerCase(), false);
    // Disabled onchain: mirrored to the database and skipped for quotes.
    const skipped = await refreshStockQuotes(db, chain, FACTORY, () => new Date('2026-09-05T00:00:00Z'));
    expect(skipped).toBe(0);
    expect((await listStocks(db)).find((s) => s.address === NVDAc.toLowerCase())?.enabled).toBe(false);
    chain.enabledOverrides.clear();
    const updated = await refreshStockQuotes(db, chain, FACTORY, () => new Date('2026-09-05T00:00:00Z'));
    expect((await listStocks(db)).find((s) => s.address === NVDAc.toLowerCase())?.enabled).toBe(true);
    expect(updated).toBe(1);
    const market = await readMarket(db, TOKEN);
    expect(market?.stock_usd8).toBe('22995730000');
  });
});

describe('metadata', () => {
  it('maps ipfs and https URIs to gateway URLs', () => {
    expect(gatewayUrl('ipfs://bafyabc', 'https://gw')).toBe('https://gw/ipfs/bafyabc');
    expect(gatewayUrl('https://x.y/z.json', 'https://gw')).toBe('https://x.y/z.json');
    expect(gatewayUrl('javascript:alert(1)', 'https://gw')).toBeNull();
  });

  it('parses ERC-7572 metadata and data URIs', async () => {
    expect(normalizeTwitter('@stockpair')).toBe('https://x.com/stockpair');
    expect(normalizeTwitter('https://twitter.com/StockPair/')).toBe('https://x.com/StockPair');
    expect(normalizeTwitter('https://evil.example/x')).toBeNull();
    expect(parseMetadata({ twitter: 'x.com' }).twitter).toBeNull();
    expect(parseMetadata({ description: ' hi ', image: 'ipfs://img', external_link: 'https://a.b' })).toEqual({
      description: 'hi',
      imageUri: 'ipfs://img',
      website: 'https://a.b',
      twitter: null,
    });
    const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify({ description: 'inline' })).toString('base64')}`;
    expect(await fetchMetadata(dataUri, 'https://gw')).toMatchObject({ description: 'inline' });
    const fetchImpl = (async () => new Response(JSON.stringify({ image: 'ipfs://pic' }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMetadata('ipfs://bafyabc', 'https://gw', fetchImpl)).toMatchObject({ imageUri: 'ipfs://pic' });
  });
});
