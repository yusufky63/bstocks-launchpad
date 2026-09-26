import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type AbiParameter, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BASE_CONTRACTS,
  BASE_STOCKS,
  decodeLaunched,
  ERC20_TRANSFER_TOPIC,
  openingPriceUsd,
  stockPairFactoryAbi,
  stockPairHookAbi,
  UNISWAP_V4_SWAP_TOPIC,
  type RawLog,
  type StockPairDeployment,
} from '@stockpair/core';
import {
  countPendingAlerts,
  createEmbeddedDb,
  insertLaunch,
  listPendingAlerts,
  listStocks,
  listCandles,
  listHolders,
  listSwaps,
  migrate,
  readCursor,
  readIndexedDeployments,
  readMarket,
  readStockQuote,
  writeCursor,
  type Db,
} from '@stockpair/core/db';

import type { ChainReader } from '../src/chain-reader';
import { backfillMetadata, fetchMetadata, gatewayUrl, metadataWorker, normalizeTelegram, normalizeTwitter, parseMetadata } from '../src/metadata';
import { refreshStockQuotes } from '../src/quotes';
import { catchUpDeployments, DeploymentMismatchError, needsMetadataFetch, syncOnce } from '../src/sync';

const FACTORY = '0x00000000000000000000000000000000000000f1' as Address;
const HOOK = '0x00000000000000000000000000000000000000c4' as Address;
const ROUTER = '0x00000000000000000000000000000000000000e0' as Address;
const NVDAc = BASE_STOCKS[0]!.address as Address;
const AAPLc = BASE_STOCKS[1]!.address as Address;
const TOKEN = '0xb2000000000000000000000000000000000000aa' as Address; // sorts before NVDAc (…0000aa < …78ee…), so the token is currency0
const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const TRADER = '0x2222222222222222222222222222222222222222' as Address;
const POOL_ID = `0x${'cd'.repeat(32)}` as Hex;
const DEPLOY_BLOCK = 1_000n;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const SUPPLY = 10n ** 27n;

type Block = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };
type LogFilter = { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint };
type Emit = Omit<RawLog, 'blockNumber' | 'blockHash'>;

/** In-memory Base: blocks with deterministic hashes, plus logs by block. */
class FakeChain implements ChainReader {
  head = 1_000n;
  logs = new Map<bigint, RawLog[]>();
  hashSalt = new Map<bigint, string>();
  senders = new Map<Hex, Address>();
  feeds = new Map<string, { answer: bigint; updatedAt: bigint }>();
  /** Every getLogs filter, in order, so a test can see what a pass asked for. */
  calls: LogFilter[] = [];
  /** Makes the nth getLogs call (1-based, counted in `calls`) fail like a dropped RPC. */
  failOnCall: number | null = null;
  /** The factory each stock's enabled flag was read from. */
  stockReads: Address[] = [];

  /** Highest number of reads of each kind the indexer had outstanding at once. */
  peak = { block: 0, sender: 0 };
  private open = { block: 0, sender: 0 };

  /** Suspends once so overlapping reads are visible in `peak` the way a real transport sees them. */
  private async gate<T>(kind: 'block' | 'sender', value: T): Promise<T> {
    this.open[kind] += 1;
    this.peak[kind] = Math.max(this.peak[kind], this.open[kind]);
    await Promise.resolve();
    this.open[kind] -= 1;
    return value;
  }

  hashOf(number: bigint): Hex {
    return keccak256(toHex(`block-${number}-${this.hashSalt.get(number) ?? ''}`));
  }

  timeOf(number: bigint): Date {
    return new Date(Number(1_757_000_000n + number * 2n) * 1000);
  }

  async getBlockNumber() {
    return this.head;
  }

  async getBlock(number: bigint): Promise<Block> {
    return this.gate('block', {
      number,
      hash: this.hashOf(number),
      parentHash: this.hashOf(number - 1n),
      timestamp: 1_757_000_000n + number * 2n,
    });
  }

  async getLogs(filter: LogFilter) {
    this.calls.push(filter);
    if (this.failOnCall === this.calls.length) throw new Error('rpc dropped the request');
    const before = this.beforeNextGetLogs;
    this.beforeNextGetLogs = null;
    if (before) await before();
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
    return this.gate('sender', this.senders.get(hash) ?? null);
  }

  enabledOverrides = new Map<string, boolean>();
  async readStockEnabled(factory: Address, stock: Address) {
    this.stockReads.push(factory);
    return this.enabledOverrides.get(stock.toLowerCase()) ?? true;
  }
  async readFeed(feed: Address) {
    return this.feeds.get(feed.toLowerCase()) ?? null;
  }

  /** The hook each deployed factory is wired to. An address with no entry has no factory code. */
  factoryHooks = new Map<string, Address>();
  /** Transactions whose receipt the node cannot find. */
  missingReceipts = new Set<Hex>();
  /** Reads made to check the deployment list, in order. */
  checks: string[] = [];
  /** Runs once, before the next getLogs answers: a second writer acting mid-pass. */
  beforeNextGetLogs: (() => Promise<void>) | null = null;

  /** Deploys these factories, each wired to its hook. */
  wire(...deployments: StockPairDeployment[]): this {
    for (const d of deployments) this.factoryHooks.set(d.factory.toLowerCase(), d.hook);
    return this;
  }

  async getTransactionLogs(hash: Hex) {
    this.checks.push(`receipt ${hash}`);
    if (this.missingReceipts.has(hash)) return null;
    const out: RawLog[] = [];
    for (const [n, logs] of this.logs) {
      for (const log of logs) if (log.transactionHash === hash) out.push({ ...log, blockHash: this.hashOf(n) });
    }
    return out.length > 0 ? out : null;
  }

  async readLaunchCreator(factory: Address, token: Address) {
    this.checks.push(`launchOf ${factory.toLowerCase()} ${token.toLowerCase()}`);
    if (!this.factoryHooks.has(factory.toLowerCase())) return null;
    for (const logs of this.logs.values()) {
      for (const log of logs) {
        const launched = log.address.toLowerCase() === factory.toLowerCase() ? decodeLaunched(log) : null;
        if (launched && launched.token.toLowerCase() === token.toLowerCase()) return launched.creator;
      }
    }
    return ZERO;
  }

  async readFactoryHook(factory: Address) {
    this.checks.push(`hook ${factory.toLowerCase()}`);
    return this.factoryHooks.get(factory.toLowerCase()) ?? null;
  }

  add(block: bigint, log: Emit) {
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

/** Encodes a log exactly as the contract emits it: indexed arguments in topics, the rest as data. */
function eventLog(abi: readonly unknown[], address: Address, eventName: string, args: Record<string, unknown>, txHash: Hex, logIndex: number): Emit {
  const unindexed = eventInputs(abi, eventName).inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi, eventName, args } as never) as unknown as [Hex, ...Hex[]];
  const data = encodeAbiParameters(unindexed, unindexed.map((i) => args[i.name!]) as never);
  return { address, topics, data, transactionHash: txHash, logIndex };
}

type LaunchSpec = { factory?: Address; token?: Address; creator?: Address; poolId?: Hex; contractURI?: string };

function launchedLog(sqrtPriceX96: bigint, txHash: Hex, logIndex: number, spec: LaunchSpec = {}): Emit {
  return eventLog(
    stockPairFactoryAbi,
    spec.factory ?? FACTORY,
    'Launched',
    {
      token: spec.token ?? TOKEN,
      creator: spec.creator ?? CREATOR,
      stock: NVDAc,
      poolId: spec.poolId ?? POOL_ID,
      sqrtPriceX96,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n,
      name: 'Test Token',
      symbol: 'TEST',
      contractURI: spec.contractURI ?? 'ipfs://bafytest',
    },
    txHash,
    logIndex,
  );
}

function swapLog(
  amount0: bigint,
  amount1: bigint,
  sqrtPriceX96: bigint,
  txHash: Hex,
  logIndex: number,
  at: { poolId?: Hex; sender?: Address } = {},
): Emit {
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [amount0, amount1, sqrtPriceX96, 10n ** 20n, 5, 0],
  );
  return {
    address: BASE_CONTRACTS.poolManager,
    topics: [UNISWAP_V4_SWAP_TOPIC, at.poolId ?? POOL_ID, `0x000000000000000000000000${(at.sender ?? ROUTER).slice(2)}` as Hex],
    data,
    transactionHash: txHash,
    logIndex,
  };
}

function transferLog(token: Address, from: Address, to: Address, value: bigint, txHash: Hex, logIndex: number): Emit {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, `0x000000000000000000000000${from.slice(2)}` as Hex, `0x000000000000000000000000${to.slice(2)}` as Hex],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    transactionHash: txHash,
    logIndex,
  };
}

function feeLog(amount: bigint, txHash: Hex, logIndex: number, at: { hook?: Address; poolId?: Hex } = {}): Emit {
  const creator = (amount * 7_000n) / 10_000n;
  return eventLog(
    stockPairHookAbi,
    at.hook ?? HOOK,
    'FeeCharged',
    { poolId: at.poolId ?? POOL_ID, stock: NVDAc, amount, creatorAmount: creator, platformAmount: amount - creator, feeBps: 100n },
    txHash,
    logIndex,
  );
}

function feesClaimedLog(hook: Address, account: Address, amount: bigint, txHash: Hex, logIndex: number): Emit {
  return eventLog(stockPairHookAbi, hook, 'FeesClaimed', { stock: NVDAc, account, amount }, txHash, logIndex);
}

function contractUriChangedLog(factory: Address, token: Address, contractURI: string, txHash: Hex, logIndex: number): Emit {
  return eventLog(stockPairFactoryAbi, factory, 'ContractURIChanged', { token, creator: CREATOR, contractURI }, txHash, logIndex);
}

function metadataLockedLog(factory: Address, token: Address, txHash: Hex, logIndex: number): Emit {
  return eventLog(stockPairFactoryAbi, factory, 'MetadataLocked', { token, creator: CREATOR }, txHash, logIndex);
}

const TOKEN_IS_CURRENCY0 = TOKEN.toLowerCase() < NVDAc.toLowerCase();
// token as currency0: raw stock per raw token ~ 2.2e-18 -> sqrtPriceX96 ~ 1.17e20
const OPENING_SQRT = 117_000_000_000_000_000_000n;
/** Swap event amounts in (amount0, amount1) order for a given token/stock delta. */
function amounts(tokenDelta: bigint, stockDelta: bigint, tokenIsCurrency0 = TOKEN_IS_CURRENCY0): [bigint, bigint] {
  return tokenIsCurrency0 ? [tokenDelta, stockDelta] : [stockDelta, tokenDelta];
}

/** A distinct transaction hash per label. */
function txOf(label: string): Hex {
  return keccak256(toHex(label));
}

type LaunchTx = {
  deployment: StockPairDeployment;
  token: Address;
  poolId: Hex;
  creator: Address;
  txHash: Hex;
  contractURI?: string;
  editable?: boolean;
  buy?: { stockIn: bigint; tokensOut: bigint };
};

/**
 * One launch transaction's logs in the order the factory emits them (LaunchAndBuy.t.sol pins it):
 * the mint and seed transfers, Launched, MetadataEditable, then for a buy FeeCharged, the Swap the
 * factory itself sends, the delivery and CreatorBought last. Returns the next free log index.
 */
function addLaunch(c: FakeChain, block: bigint, t: LaunchTx): number {
  const { factory, hook } = t.deployment;
  let i = 0;
  c.add(block, transferLog(t.token, ZERO, factory, SUPPLY, t.txHash, i++));
  c.add(block, transferLog(t.token, factory, BASE_CONTRACTS.poolManager, SUPPLY, t.txHash, i++));
  c.add(block, launchedLog(OPENING_SQRT, t.txHash, i++, { factory, token: t.token, creator: t.creator, poolId: t.poolId, contractURI: t.contractURI }));
  if (t.editable) {
    c.add(block, eventLog(stockPairFactoryAbi, factory, 'MetadataEditable', { token: t.token, creator: t.creator }, t.txHash, i++));
  }
  if (t.buy) {
    const fee = t.buy.stockIn / 100n;
    c.add(block, feeLog(fee, t.txHash, i++, { hook, poolId: t.poolId }));
    c.add(block, swapLog(...amounts(t.buy.tokensOut, -(t.buy.stockIn - fee)), OPENING_SQRT + 1_000n, t.txHash, i++, { poolId: t.poolId, sender: factory }));
    c.add(block, transferLog(t.token, BASE_CONTRACTS.poolManager, t.creator, t.buy.tokensOut, t.txHash, i++));
    c.add(
      block,
      eventLog(
        stockPairFactoryAbi,
        factory,
        'CreatorBought',
        { token: t.token, creator: t.creator, poolId: t.poolId, stockIn: t.buy.stockIn, fee, tokensOut: t.buy.tokensOut },
        t.txHash,
        i++,
      ),
    );
  }
  return i;
}

/** A buy through a router: the hook's fee, the Swap and the delivery. Returns the next free log index. */
function addRouterBuy(c: FakeChain, block: bigint, a: { hook: Address; token: Address; poolId: Hex; to: Address; stockIn: bigint; tokensOut: bigint; txHash: Hex; logIndex?: number }): number {
  let i = a.logIndex ?? 0;
  const fee = a.stockIn / 100n;
  c.add(block, feeLog(fee, a.txHash, i++, { hook: a.hook, poolId: a.poolId }));
  c.add(block, swapLog(...amounts(a.tokensOut, -(a.stockIn - fee)), OPENING_SQRT + 2_000n, a.txHash, i++, { poolId: a.poolId, sender: ROUTER }));
  c.add(block, transferLog(a.token, BASE_CONTRACTS.poolManager, a.to, a.tokensOut, a.txHash, i++));
  return i;
}

async function freshDb(): Promise<Db> {
  const fresh = await createEmbeddedDb();
  await migrate(fresh);
  return fresh;
}

let db: Db;
let chain: FakeChain;
const deployment = { factory: FACTORY, hook: HOOK, router: ROUTER, deployBlock: DEPLOY_BLOCK };

beforeAll(async () => {
  db = await freshDb();
  chain = new FakeChain();
});

afterAll(async () => {
  await db.close();
});

const sync = () => syncOnce({ db, chain, deployments: [deployment], confirmations: 6, maxRange: 50 });

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
    expect(result).toMatchObject({ status: 'progressed', fromBlock: 1_000n, toBlock: 1_024n, launches: 1, swaps: 1, transfers: 4, metadataUpdates: 0 });

    const market = await readMarket(db, TOKEN);
    expect(market?.symbol).toBe('TEST');
    expect(market?.token_is_currency0).toBe(TOKEN_IS_CURRENCY0);
    // The PoolManager custodies the locked supply; it is liquidity, not a holder. Counting it here
    // while holderConcentration excluded it put two different holder numbers on one screen.
    expect(market?.holder_count).toBe(1); // the trader only
    expect(market?.trades_24h).toBe(0); // fake block time is in 2025 relative to now()
    // Each launch records the deployment that made it.
    expect(market).toMatchObject({ factory: FACTORY, hook: HOOK, metadata_editable: false });

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

  it('reads a busy range\'s blocks and senders together instead of one at a time', async () => {
    // A range whose every block carries a trade: read serially this is one round trip per block
    // plus one per transaction, which is what put the indexer behind the chain.
    for (let i = 0; i < 30; i += 1) {
      const block = 1_035n + BigInt(i);
      const tx = `0xdddd${i.toString(16).padStart(60, '0')}` as Hex;
      chain.add(block, feeLog(1_000n, tx, 0));
      chain.add(block, swapLog(...amounts(10n ** 20n, -1_000_000n), OPENING_SQRT + BigInt(i), tx, 1));
      chain.add(block, transferLog(TOKEN, BASE_CONTRACTS.poolManager, TRADER, 10n ** 20n, tx, 2));
      chain.senders.set(tx, TRADER);
    }
    chain.head = 1_075n;
    chain.peak = { block: 0, sender: 0 };

    const result = await sync();
    expect(result).toMatchObject({ status: 'progressed', fromBlock: 1_035n, swaps: 30, transfers: 30 });
    // 30 blocks and 30 transactions, all in flight at once rather than 60 sequential waits.
    expect(chain.peak.block).toBeGreaterThanOrEqual(30);
    expect(chain.peak.sender).toBe(30);
  });
});

describe('what the sync queued for the channel', () => {
  // The outbox is written inside syncOnce's own transaction by the real decoder, so this is the
  // only place the shape it produces is checked against the shape the alerts service reads.
  it('queued one row per launch and per swap, keyed so a replay cannot duplicate them', async () => {
    const rows = await listPendingAlerts(db, 200);
    expect(rows.length).toBe(await countPendingAlerts(db));

    const launches = rows.filter((r) => r.kind === 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.token).toBe(TOKEN.toLowerCase());

    const trades = rows.filter((r) => r.kind === 'trade');
    // The buy, the sell that came back after the reorg, and the thirty from the busy range.
    expect(trades).toHaveLength(32);

    // A key on every row, and no two the same: this is what stops a reorged-and-reindexed swap
    // being announced twice.
    const keys = await db.query<{ dedupe_key: string | null }>('SELECT dedupe_key FROM alert_outbox');
    expect(keys.every((k) => typeof k.dedupe_key === 'string' && k.dedupe_key.length > 0)).toBe(true);
    expect(new Set(keys.map((k) => k.dedupe_key)).size).toBe(keys.length);
  });

  it('snapshotted everything the alerts service needs to render, and nothing it has to re-read', async () => {
    const rows = await listPendingAlerts(db, 200);
    const buy = rows.find((r) => r.kind === 'trade' && (r.payload as { side: string }).side === 'buy');
    expect(buy).toBeDefined();
    const payload = buy!.payload as Record<string, unknown>;

    expect(payload).toMatchObject({
      side: 'buy',
      amountStockRaw: '99000000',
      amountTokenRaw: (10n ** 24n).toString(),
      trader: TRADER,
      stockDecimals: 8,
      launchBuy: false,
    });
    expect(typeof payload.txHash).toBe('string');
    expect(typeof payload.blockTime).toBe('string');
    // The stock's USD price as it stood when the trade was committed. A post has to say what the
    // trade was worth then, not when the dispatcher gets to it.
    expect(payload.stockUsd8 === null || typeof payload.stockUsd8 === 'string').toBe(true);
  });

  // Replaying a range is ordinary: it is what the indexer does after every reorg.
  it('queues nothing new when the same range is indexed again', async () => {
    const before = await countPendingAlerts(db);
    chain.hashSalt.set(1_064n, 'reorged-again');
    await sync();
    await sync();
    expect(await countPendingAlerts(db)).toBe(before);
  });
});

describe('stock quotes', () => {
  const NEWEST_FACTORY = '0x00000000000000000000000000000000000000f9' as Address;
  const now = () => new Date('2026-09-05T00:00:00Z');

  it('mirrors enabled from the newest factory and keeps pricing every stock that has a launch', async () => {
    chain.feeds.set(BASE_STOCKS[0]!.feed.toLowerCase(), { answer: 22_995_730_000n, updatedAt: 1_757_000_000n });
    chain.feeds.set(BASE_STOCKS[1]!.feed.toLowerCase(), { answer: 25_000_000_000n, updatedAt: 1_757_000_000n });
    // Disabled on the newest factory. NVDAc has a launch, AAPLc has none.
    chain.enabledOverrides.set(NVDAc.toLowerCase(), false);
    chain.enabledOverrides.set(AAPLc.toLowerCase(), false);
    chain.stockReads = [];

    const updated = await refreshStockQuotes(db, chain, NEWEST_FACTORY, now);
    expect(new Set(chain.stockReads)).toEqual(new Set([NEWEST_FACTORY]));
    const stocks = await listStocks(db);
    // Mirrored for the create form, which only offers what the newest factory accepts...
    expect(stocks.find((s) => s.address === NVDAc.toLowerCase())?.enabled).toBe(false);
    expect(stocks.find((s) => s.address === AAPLc.toLowerCase())?.enabled).toBe(false);
    // ...but the launched token keeps trading on its own factory, so its stock keeps its price.
    expect(updated).toBe(1);
    expect((await readStockQuote(db, NVDAc))?.price_usd8).toBe('22995730000');
    expect(await readStockQuote(db, AAPLc)).toBeNull();

    chain.enabledOverrides.clear();
    expect(await refreshStockQuotes(db, chain, NEWEST_FACTORY, now)).toBe(2);
    expect((await listStocks(db)).find((s) => s.address === NVDAc.toLowerCase())?.enabled).toBe(true);
    expect((await readStockQuote(db, AAPLc))?.price_usd8).toBe('25000000000');
    const market = await readMarket(db, TOKEN);
    expect(market?.stock_usd8).toBe('22995730000');
  });
});

describe('metadata', () => {
  it('maps ipfs and https URIs to gateway URLs', () => {
    expect(gatewayUrl('ipfs://bafyabc', 'https://gw')).toBe('https://gw/ipfs/bafyabc');
    expect(gatewayUrl('https://x.y/z.json', 'https://gw')).toBe('https://x.y/z.json');
    expect(gatewayUrl('javascript:alert(1)', 'https://gw')).toBeNull();
    expect(gatewayUrl('ipfs://bafyabc/meta%20data.json', 'https://gw')).toBe('https://gw/ipfs/bafyabc/meta%20data.json');
    expect(gatewayUrl('ipfs://bafyabc/', 'https://gw')).toBe('https://gw/ipfs/bafyabc/');
  });

  // The factory accepts any printable bytes after ipfs://; URL normalisation must not walk out of
  // the CID into a mutable /ipns/ name.
  it('refuses an ipfs URI that resolves outside its own CID', () => {
    for (const uri of [
      'ipfs://../ipns/k51qzi5uqu5d/meta.json',
      'ipfs://bafyabc/../../ipns/evil.eth',
      'ipfs://bafyabc/%2e%2e/%2E%2e/ipns/evil.eth',
      'ipfs://%2e%2e/ipns/k51/meta.json',
      'ipfs://a\\..\\ipns',
      'ipfs://',
      'ipfs:///ipns/k51',
    ]) {
      expect(gatewayUrl(uri, 'https://gw'), uri).toBeNull();
    }
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
      telegram: null,
    });
    const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify({ description: 'inline' })).toString('base64')}`;
    expect(await fetchMetadata(dataUri, 'https://gw')).toMatchObject({ description: 'inline' });
    const fetchImpl = (async () => new Response(JSON.stringify({ image: 'ipfs://pic' }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMetadata('ipfs://bafyabc', 'https://gw', fetchImpl)).toMatchObject({ imageUri: 'ipfs://pic' });
  });

  it('reads telegram from the key the launch form pins, in the same form as a signed profile', () => {
    expect(parseMetadata({ telegram: '@bstocks_chat' }).telegram).toBe('https://t.me/bstocks_chat');
    expect(parseMetadata({ telegram: 'https://telegram.me/bstocks_chat/' }).telegram).toBe('https://t.me/bstocks_chat');
    expect(normalizeTelegram('t.me/+AbCdEf123')).toBe('https://t.me/+AbCdEf123');
    expect(normalizeTelegram('https://evil.example/chat')).toBeNull();
    expect(normalizeTelegram('abc')).toBeNull();
    expect(parseMetadata({ tg: '@bstocks_chat' }).telegram).toBeNull();
  });
});

describe('needsMetadataFetch', () => {
  const progressed = { status: 'progressed', fromBlock: 1n, toBlock: 2n, launches: 0, swaps: 3, transfers: 3, metadataUpdates: 0, deploymentsBehind: [] } as const;
  it('asks for a fetch after new launches or new onchain profile changes, and not otherwise', () => {
    expect(needsMetadataFetch(progressed)).toBe(false);
    expect(needsMetadataFetch({ ...progressed, launches: 1 })).toBe(true);
    expect(needsMetadataFetch({ ...progressed, metadataUpdates: 1 })).toBe(true);
    expect(needsMetadataFetch({ status: 'idle', nextBlock: 1n, safeBlock: 0n })).toBe(false);
    expect(needsMetadataFetch({ status: 'reorg', rolledBackTo: 1n })).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// The creator's buy inside the launch transaction
// -------------------------------------------------------------------------------------------------

describe('launch and buy in one transaction', () => {
  const SMART_WALLET = '0x3333333333333333333333333333333333333333' as Address;
  const BUNDLER = '0x4444444444444444444444444444444444444444' as Address;
  const T1 = '0xb2000000000000000000000000000000000000a1' as Address;
  const T2 = '0xb2000000000000000000000000000000000000a2' as Address;
  const T3 = '0xb2000000000000000000000000000000000000a3' as Address;
  const P1 = `0x${'a1'.repeat(32)}` as Hex;
  const P2 = `0x${'a2'.repeat(32)}` as Hex;
  const P3 = `0x${'a3'.repeat(32)}` as Hex;
  const L1 = txOf('launch-and-buy');
  const L2 = txOf('plain-launch');
  const L3 = txOf('smart-wallet-launch');
  const R1 = txOf('router-buy');
  const BUY = { stockIn: 500_000_000n, tokensOut: 123_456_789n * 10n ** 18n };
  const SMART_BUY = { stockIn: 200_000_000n, tokensOut: 55_000_000n * 10n ** 18n };

  let ldb: Db;
  const c = new FakeChain();
  let result: Awaited<ReturnType<typeof syncOnce>>;

  beforeAll(async () => {
    ldb = await freshDb();
    // An editable launch with a buy, signed and sent by the creator.
    addLaunch(c, 1_010n, { deployment, token: T1, poolId: P1, creator: CREATOR, txHash: L1, editable: true, buy: BUY });
    c.senders.set(L1, CREATOR);
    // A plain launch: no buy, fixed profile.
    addLaunch(c, 1_011n, { deployment, token: T2, poolId: P2, creator: TRADER, txHash: L2 });
    // A smart wallet's launchAndBuy, sent by a bundler, which also buys more through the router in
    // the same transaction.
    const next = addLaunch(c, 1_012n, { deployment, token: T3, poolId: P3, creator: SMART_WALLET, txHash: L3, buy: SMART_BUY });
    addRouterBuy(c, 1_012n, { hook: HOOK, token: T3, poolId: P3, to: SMART_WALLET, stockIn: 30_000_000n, tokensOut: 10n ** 21n, txHash: L3, logIndex: next });
    c.senders.set(L3, BUNDLER);
    // Somebody else buys T1 through the router afterwards.
    addRouterBuy(c, 1_013n, { hook: HOOK, token: T1, poolId: P1, to: TRADER, stockIn: 100_000_000n, tokensOut: 10n ** 24n, txHash: R1 });
    c.senders.set(R1, TRADER);
    c.head = 1_030n;
    result = await syncOnce({ db: ldb, chain: c, deployments: [deployment], confirmations: 6, maxRange: 50 });
  });

  afterAll(async () => {
    await ldb.close();
  });

  it('stores one launch row and one swap row for the launch transaction, with the fee paired by position', async () => {
    expect(result).toMatchObject({ status: 'progressed', launches: 3, swaps: 4 });
    expect(await ldb.query('SELECT token FROM launches WHERE tx_hash = $1', [L1])).toEqual([{ token: T1 }]);
    const inLaunchTx = (await listSwaps(ldb, { token: T1 })).filter((s) => s.tx_hash === L1);
    expect(inLaunchTx).toHaveLength(1);
    expect(inLaunchTx[0]).toMatchObject({
      side: 'buy',
      sender: FACTORY,
      trader: CREATOR,
      is_creator: true,
      amount_stock_raw: '495000000',
      fee_stock_raw: '5000000',
      amount_token_raw: BUY.tokensOut.toString(),
    });
  });

  it('derives the creator buy exactly, and none for a launch without one', async () => {
    expect(await readMarket(ldb, T1)).toMatchObject({
      creator_buy_stock_raw: '500000000',
      creator_buy_fee_raw: '5000000',
      creator_buy_token_raw: BUY.tokensOut.toString(),
    });
    expect(await readMarket(ldb, T2)).toMatchObject({
      creator_buy_stock_raw: null,
      creator_buy_fee_raw: null,
      creator_buy_token_raw: null,
    });
  });

  it('takes a bundled launch buy\'s trader from CreatorBought, and leaves every other swap on tx.from', async () => {
    const swaps = await listSwaps(ldb, { token: T3 });
    expect(swaps).toHaveLength(2);
    const launchBuy = swaps.find((s) => s.sender === FACTORY);
    const routed = swaps.find((s) => s.sender === ROUTER);
    // The factory's swap is the smart wallet's own buy, not the bundler's.
    expect(launchBuy).toMatchObject({ trader: SMART_WALLET, is_creator: true, fee_stock_raw: '2000000' });
    // Same transaction, sent through the router: the only sender we know is the bundler.
    expect(routed).toMatchObject({ trader: BUNDLER, is_creator: false, fee_stock_raw: '300000' });
    // The creator-buy aggregate counts the launch buy only.
    expect(await readMarket(ldb, T3)).toMatchObject({
      creator_buy_stock_raw: SMART_BUY.stockIn.toString(),
      creator_buy_token_raw: SMART_BUY.tokensOut.toString(),
    });
    // An ordinary router buy in its own transaction keeps its sender.
    expect((await listSwaps(ldb, { token: T1 })).find((s) => s.tx_hash === R1)).toMatchObject({ trader: TRADER, is_creator: false });
  });

  it('sets metadata_editable from MetadataEditable in the same batch as the launch', async () => {
    expect((await readMarket(ldb, T1))?.metadata_editable).toBe(true);
    expect((await readMarket(ldb, T2))?.metadata_editable).toBe(false);
    expect((await readMarket(ldb, T3))?.metadata_editable).toBe(false);
  });

  it('queues the launch card with the creator buy, the opening price and the profile mode', async () => {
    const rows = await listPendingAlerts(ldb, 200);
    const launch = (token: Address) => rows.find((r) => r.kind === 'launch' && r.token === token.toLowerCase())!.payload as Record<string, unknown>;

    const opening = openingPriceUsd(OPENING_SQRT, true, 8, 22_995_730_000n);
    expect(opening).toBeGreaterThan(0);
    expect(launch(T1)).toMatchObject({
      openingPriceUsd: opening,
      metadataEditable: true,
      creatorBuy: {
        stockInRaw: '500000000',
        feeRaw: '5000000',
        tokensOutRaw: BUY.tokensOut.toString(),
        supplyBps: 1234, // 123,456,789 of 1,000,000,000
      },
    });
    expect(launch(T2)).toMatchObject({ openingPriceUsd: opening, metadataEditable: false, creatorBuy: null });
    expect(launch(T3)).toMatchObject({ creatorBuy: { stockInRaw: '200000000', supplyBps: 550 } });
  });

  it('marks the launch buy\'s trade alert, and only that one, as launchBuy', async () => {
    const trades = (await listPendingAlerts(ldb, 200))
      .filter((r) => r.kind === 'trade')
      .map((r) => r.payload as { txHash: string; trader: string; launchBuy: boolean });
    expect(trades).toHaveLength(4);
    expect(trades.filter((t) => t.launchBuy).map((t) => [t.txHash, t.trader])).toEqual([
      [L1, CREATOR],
      [L3, SMART_WALLET],
    ]);
  });
});

// -------------------------------------------------------------------------------------------------
// Onchain profile changes
// -------------------------------------------------------------------------------------------------

describe('onchain profile changes', () => {
  const GATEWAY = 'https://gw.test';
  const T = '0xb2000000000000000000000000000000000000b1' as Address;
  const P = `0x${'b1'.repeat(32)}` as Hex;
  const PROFILES: Record<string, Record<string, unknown>> = {
    bafylaunch: { description: 'launch profile' },
    bafyfirst: { description: 'first update', telegram: '@first_chat' },
    bafysecond: { description: 'second update' },
    bafythird: { description: 'third update' },
    bafyfourth: { description: 'fourth update' },
    bafyfifth: { description: 'fifth update' },
  };

  let pdb: Db;
  const c = new FakeChain();
  const requested: string[] = [];
  const syncP = () => syncOnce({ db: pdb, chain: c, deployments: [deployment], confirmations: 6, maxRange: 10 });

  /** Serves PROFILES by CID; `hold` parks the fetch of one CID until the test lets it go. */
  function gatewayFetch(hold?: { cid: string; started: () => void; release: Promise<void> }): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const cid = url.slice(`${GATEWAY}/ipfs/`.length);
      if (hold?.cid === cid) {
        hold.started();
        await hold.release;
      }
      const body = PROFILES[cid];
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('missing', { status: 404 });
    }) as typeof fetch;
  }

  /** Starts a backfill whose fetch of `cid` stays in flight until `release` is called. */
  async function startHeldBackfill(cid: string) {
    let started!: () => void;
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const pending = backfillMetadata(pdb, GATEWAY, gatewayFetch({ cid, started, release: released }));
    await inFlight;
    return { pending, release };
  }

  const fetchState = async () =>
    (
      await pdb.query<{ metadata_fetched_at: Date | null; metadata_attempts: number; metadata_last_attempt_at: Date | null }>(
        'SELECT metadata_fetched_at, metadata_attempts, metadata_last_attempt_at FROM launches WHERE token = $1',
        [T.toLowerCase()],
      )
    )[0]!;

  beforeAll(async () => {
    pdb = await freshDb();
    addLaunch(c, 1_010n, { deployment, token: T, poolId: P, creator: CREATOR, txHash: txOf('editable-launch'), editable: true, contractURI: 'ipfs://bafylaunch' });
    c.head = 1_030n;
    for (let result = await syncP(); result.status === 'progressed'; result = await syncP()) {
      // index up to the head
    }
    expect(await backfillMetadata(pdb, GATEWAY, gatewayFetch())).toBe(1);
    expect((await readMarket(pdb, T))?.description).toBe('launch profile');
  });

  afterAll(async () => {
    await pdb.close();
  });

  it('records a ContractURIChanged, points the launch at the new URI and restarts its fetch', async () => {
    // A fetch history the new URI must not inherit.
    await pdb.query('UPDATE launches SET metadata_attempts = 3, metadata_last_attempt_at = now() WHERE token = $1', [T.toLowerCase()]);
    // Control characters are cleaned the same way as the launch's own text.
    c.add(1_026n, contractUriChangedLog(FACTORY, T, 'ipfs://bafyfirst\u0007', txOf('first-update'), 0));
    // A token we never indexed: dropped, rather than failing the batch on its missing launch row.
    c.add(1_026n, contractUriChangedLog(FACTORY, '0xb2000000000000000000000000000000000000ff', 'ipfs://bafyx', txOf('stranger'), 1));
    c.head = 1_040n;

    const result = await syncP();
    expect(result).toMatchObject({ status: 'progressed', fromBlock: 1_025n, toBlock: 1_034n, metadataUpdates: 1 });
    expect(needsMetadataFetch(result)).toBe(true);
    expect(await pdb.query('SELECT token, kind, contract_uri, block_number FROM metadata_updates')).toEqual([
      { token: T.toLowerCase(), kind: 'uri', contract_uri: 'ipfs://bafyfirst', block_number: '1026' },
    ]);
    const market = await readMarket(pdb, T);
    expect(market).toMatchObject({
      contract_uri: 'ipfs://bafylaunch', // the launch value is never overwritten
      current_contract_uri: 'ipfs://bafyfirst',
      metadata_fetched_at: null,
      // The old profile stays up until the new one has been read.
      description: 'launch profile',
      profile_updates: 1,
    });
    expect(await fetchState()).toMatchObject({ metadata_attempts: 0, metadata_last_attempt_at: null });

    requested.length = 0;
    expect(await backfillMetadata(pdb, GATEWAY, gatewayFetch())).toBe(1);
    expect(requested).toEqual([`${GATEWAY}/ipfs/bafyfirst`]);
    expect(await readMarket(pdb, T)).toMatchObject({ description: 'first update', telegram: 'https://t.me/first_chat' });
  });

  it('stamps metadata_locked_at from MetadataLocked', async () => {
    c.add(1_036n, contractUriChangedLog(FACTORY, T, 'ipfs://bafysecond', txOf('second-update'), 0));
    c.add(1_036n, metadataLockedLog(FACTORY, T, txOf('second-update'), 1));
    c.head = 1_050n;

    expect(await syncP()).toMatchObject({ status: 'progressed', fromBlock: 1_035n, toBlock: 1_044n, metadataUpdates: 2 });
    const market = await readMarket(pdb, T);
    expect(market?.metadata_locked_at).toEqual(c.timeOf(1_036n));
    expect(market?.current_contract_uri).toBe('ipfs://bafysecond');
    expect(await backfillMetadata(pdb, GATEWAY, gatewayFetch())).toBe(1);
    expect((await readMarket(pdb, T))?.description).toBe('second update');
  });

  it('undoes a reorged update and lock, going back to the previous URI and reading it again', async () => {
    // The canonical chain no longer has block 1036's update and lock.
    c.logs.delete(1_036n);
    c.hashSalt.set(1_036n, 'reorged');
    c.hashSalt.set(1_044n, 'reorged');

    expect(await syncP()).toMatchObject({ status: 'reorg', rolledBackTo: 1_035n });
    expect(await readMarket(pdb, T)).toMatchObject({
      current_contract_uri: 'ipfs://bafyfirst',
      metadata_locked_at: null,
      metadata_fetched_at: null,
      profile_updates: 1,
    });
    expect(await syncP()).toMatchObject({ status: 'progressed', fromBlock: 1_035n, metadataUpdates: 0 });

    requested.length = 0;
    expect(await backfillMetadata(pdb, GATEWAY, gatewayFetch())).toBe(1);
    expect(requested).toEqual([`${GATEWAY}/ipfs/bafyfirst`]);
    expect((await readMarket(pdb, T))?.description).toBe('first update');
  });

  it('does not let a fetch of the old URI that is still in flight overwrite the new one', async () => {
    c.add(1_046n, contractUriChangedLog(FACTORY, T, 'ipfs://bafythird', txOf('third-update'), 0));
    c.head = 1_060n;
    await syncP();

    // The third profile is being read when the creator replaces it with a fourth.
    const held = await startHeldBackfill('bafythird');
    c.add(1_056n, contractUriChangedLog(FACTORY, T, 'ipfs://bafyfourth', txOf('fourth-update'), 0));
    c.head = 1_070n;
    expect(await syncP()).toMatchObject({ status: 'progressed', metadataUpdates: 1 });
    held.release();

    // The guarded write refused the stale document.
    expect(await held.pending).toBe(0);
    expect(await readMarket(pdb, T)).toMatchObject({
      current_contract_uri: 'ipfs://bafyfourth',
      description: 'first update',
      metadata_fetched_at: null,
    });

    requested.length = 0;
    expect(await backfillMetadata(pdb, GATEWAY, gatewayFetch())).toBe(1);
    expect(requested).toEqual([`${GATEWAY}/ipfs/bafyfourth`]);
    expect((await readMarket(pdb, T))?.description).toBe('fourth update');
  });

  it('does not count a failed fetch of a replaced URI against the new one', async () => {
    c.add(1_066n, contractUriChangedLog(FACTORY, T, 'ipfs://bafymissing', txOf('missing-update'), 0));
    c.head = 1_080n;
    await syncP();

    const held = await startHeldBackfill('bafymissing');
    c.add(1_076n, contractUriChangedLog(FACTORY, T, 'ipfs://bafyfifth', txOf('fifth-update'), 0));
    c.head = 1_090n;
    await syncP();
    held.release();

    expect(await held.pending).toBe(0);
    // The 404 belonged to the replaced URI; the new one starts with a clean slate and no wait.
    expect(await fetchState()).toMatchObject({ metadata_attempts: 0, metadata_last_attempt_at: null });
    expect(await backfillMetadata(pdb, GATEWAY, gatewayFetch())).toBe(1);
    expect((await readMarket(pdb, T))?.description).toBe('fifth update');
  });
});

// -------------------------------------------------------------------------------------------------
// Several deployments
// -------------------------------------------------------------------------------------------------

const OLD = deployment;
const NEW: StockPairDeployment = {
  factory: '0x00000000000000000000000000000000000000f2',
  hook: '0x00000000000000000000000000000000000000c5',
  router: '0x00000000000000000000000000000000000000e1',
  deployBlock: 1_005n,
};
const T_OLD = '0xb2000000000000000000000000000000000000c1' as Address;
const P_OLD = `0x${'c1'.repeat(32)}` as Hex;
const T_NEW = '0xb2000000000000000000000000000000000000c2' as Address;
const P_NEW = `0x${'c2'.repeat(32)}` as Hex;
const NEW_BUY = { stockIn: 300_000_000n, tokensOut: 40_000_000n * 10n ** 18n };

describe('two deployments in one range', () => {
  const T_DECOY = '0xb2000000000000000000000000000000000000c9' as Address;
  let ddb: Db;
  const c = new FakeChain().wire(OLD, NEW);

  beforeAll(async () => {
    ddb = await freshDb();
  });

  afterAll(async () => {
    await ddb.close();
  });

  it('records every deployment on a fresh database without a pass of its own', async () => {
    expect(await catchUpDeployments({ db: ddb, chain: c, deployments: [OLD, NEW], maxRange: 50 })).toEqual([]);
    expect(c.calls).toEqual([]);
    // Nothing is indexed yet; the main pass starts at the oldest deploy block and covers both.
    expect(await readIndexedDeployments(ddb)).toEqual([
      { factory: FACTORY, caught_up_through: '999' },
      { factory: NEW.factory, caught_up_through: '999' },
    ]);
  });

  it('indexes both, storing each launch with its own factory and hook', async () => {
    addLaunch(c, 1_010n, { deployment: OLD, token: T_OLD, poolId: P_OLD, creator: CREATOR, txHash: txOf('old-launch') });
    addLaunch(c, 1_011n, { deployment: NEW, token: T_NEW, poolId: P_NEW, creator: CREATOR, txHash: txOf('new-launch'), buy: NEW_BUY });
    c.senders.set(txOf('new-launch'), CREATOR);
    addRouterBuy(c, 1_012n, { hook: OLD.hook, token: T_OLD, poolId: P_OLD, to: TRADER, stockIn: 100_000_000n, tokensOut: 10n ** 24n, txHash: txOf('old-buy') });
    c.senders.set(txOf('old-buy'), TRADER);
    c.add(1_013n, feesClaimedLog(OLD.hook, CREATOR, 700_000n, txOf('claims'), 0));
    c.add(1_013n, feesClaimedLog(NEW.hook, CREATOR, 2_100_000n, txOf('claims'), 1));
    // Right topic, wrong kind of contract: a Launched from a hook and a FeeCharged from a factory.
    c.add(1_014n, launchedLog(OPENING_SQRT, txOf('decoys'), 0, { factory: NEW.hook, token: T_DECOY, poolId: `0x${'c9'.repeat(32)}` as Hex }));
    c.add(1_014n, feeLog(999n, txOf('decoys'), 1, { hook: NEW.factory, poolId: P_NEW }));
    c.head = 1_030n;

    const result = await syncOnce({ db: ddb, chain: c, deployments: [OLD, NEW], confirmations: 6, maxRange: 50 });
    expect(result).toMatchObject({ status: 'progressed', fromBlock: 1_000n, toBlock: 1_024n, launches: 2, swaps: 2 });
    expect(c.calls[0]?.address).toEqual([OLD.factory, OLD.hook, NEW.factory, NEW.hook]);

    expect(await readMarket(ddb, T_OLD)).toMatchObject({ factory: OLD.factory, hook: OLD.hook, creator_buy_stock_raw: null });
    expect(await readMarket(ddb, T_NEW)).toMatchObject({
      factory: NEW.factory,
      hook: NEW.hook,
      creator_buy_stock_raw: NEW_BUY.stockIn.toString(),
      creator_buy_token_raw: NEW_BUY.tokensOut.toString(),
    });
    expect(await readMarket(ddb, T_DECOY)).toBeNull();
    expect((await listSwaps(ddb, { token: T_OLD }))[0]).toMatchObject({ trader: TRADER, fee_stock_raw: '1000000' });
    expect((await listSwaps(ddb, { token: T_NEW }))[0]).toMatchObject({ trader: CREATOR, fee_stock_raw: '3000000' });
    expect(await ddb.query('SELECT amount_raw FROM fee_events ORDER BY amount_raw')).toEqual([
      { amount_raw: '1000000' },
      { amount_raw: '3000000' },
    ]);
    expect(await ddb.query('SELECT amount_raw FROM fee_claims ORDER BY amount_raw')).toEqual([
      { amount_raw: '700000' },
      { amount_raw: '2100000' },
    ]);
  });
});

describe('a deployment added below the cursor', () => {
  const NEWER: StockPairDeployment = {
    factory: '0x00000000000000000000000000000000000000f3',
    hook: '0x00000000000000000000000000000000000000c6',
    router: '0x00000000000000000000000000000000000000e2',
    deployBlock: 1_020n,
  };
  const T_NEWER = '0xb2000000000000000000000000000000000000c3' as Address;
  const P_NEWER = `0x${'c3'.repeat(32)}` as Hex;
  let cdb: Db;
  const c = new FakeChain().wire(OLD, NEW, NEWER);
  const addressesOf = (filter: LogFilter) =>
    (Array.isArray(filter.address) ? filter.address : filter.address ? [filter.address] : []).map((a) => a.toLowerCase());
  const poolsOf = (filter: LogFilter) => ((filter.topics?.[1] ?? []) as Hex[]).map((p) => p.toLowerCase());
  const count = async (sql: string, params: unknown[] = []) => Number((await cdb.query<{ n: string }>(sql, params))[0]!.n);

  beforeAll(async () => {
    cdb = await freshDb();
    // The chain holds both deployments' activity; the indexer at first only knows the old one.
    addLaunch(c, 1_010n, { deployment: OLD, token: T_OLD, poolId: P_OLD, creator: CREATOR, txHash: txOf('old-launch') });
    addLaunch(c, 1_011n, { deployment: NEW, token: T_NEW, poolId: P_NEW, creator: CREATOR, txHash: txOf('new-launch'), buy: NEW_BUY });
    c.senders.set(txOf('new-launch'), CREATOR);
    addRouterBuy(c, 1_012n, { hook: OLD.hook, token: T_OLD, poolId: P_OLD, to: TRADER, stockIn: 100_000_000n, tokensOut: 10n ** 24n, txHash: txOf('old-buy') });
    c.senders.set(txOf('old-buy'), TRADER);
    addRouterBuy(c, 1_015n, { hook: NEW.hook, token: T_NEW, poolId: P_NEW, to: TRADER, stockIn: 50_000_000n, tokensOut: 10n ** 23n, txHash: txOf('new-buy') });
    c.senders.set(txOf('new-buy'), TRADER);
    c.head = 1_030n;
    expect(await syncOnce({ db: cdb, chain: c, deployments: [OLD], confirmations: 6, maxRange: 50 })).toMatchObject({
      status: 'progressed',
      toBlock: 1_024n,
      launches: 1,
    });
    // As a database indexed before launches recorded their deployment would look.
    await cdb.query('UPDATE launches SET factory = NULL, hook = NULL');
  });

  afterAll(async () => {
    await cdb.close();
  });

  it('catches the new deployment up to the cursor without re-reading the old one', async () => {
    const before = {
      alerts: await countPendingAlerts(cdb),
      oldSwaps: await count('SELECT count(*) AS n FROM swaps WHERE token = $1', [T_OLD.toLowerCase()]),
      oldTransfers: await count('SELECT count(*) AS n FROM transfers WHERE token = $1', [T_OLD.toLowerCase()]),
      oldHolders: await listHolders(cdb, T_OLD),
      cursor: await readCursor(cdb),
    };
    expect(before.oldSwaps).toBe(1);
    c.calls = [];

    // A small window, so the launch (1011) and the later trade (1015) land in different windows.
    const passed = await catchUpDeployments({ db: cdb, chain: c, deployments: [OLD, NEW], maxRange: 7 });
    expect(passed).toEqual([NEW]);

    // Old rows were stamped with the factory their receipts name: the one the cursor was following.
    expect(await readMarket(cdb, T_OLD)).toMatchObject({ factory: OLD.factory, hook: OLD.hook });
    // The pass read only the new deployment, its pool and its token, over [deploy block, cursor).
    expect(c.calls.length).toBeGreaterThan(0);
    for (const call of c.calls) {
      expect(addressesOf(call)).not.toContain(OLD.factory.toLowerCase());
      expect(addressesOf(call)).not.toContain(OLD.hook.toLowerCase());
      expect(addressesOf(call)).not.toContain(T_OLD.toLowerCase());
      expect(poolsOf(call)).not.toContain(P_OLD.toLowerCase());
      expect(call.fromBlock).toBeGreaterThanOrEqual(1_005n);
      expect(call.toBlock).toBeLessThanOrEqual(1_024n);
    }
    expect(new Set(c.calls.map((call) => call.fromBlock))).toEqual(new Set([1_005n, 1_012n, 1_019n]));

    // The new deployment's launch, its buy and the trade in a later window are all there.
    expect(await readMarket(cdb, T_NEW)).toMatchObject({
      factory: NEW.factory,
      hook: NEW.hook,
      creator_buy_stock_raw: NEW_BUY.stockIn.toString(),
    });
    const newSwaps = await listSwaps(cdb, { token: T_NEW });
    expect(newSwaps.map((s) => [s.trader, s.fee_stock_raw])).toEqual([
      [TRADER, '500000'],
      [CREATOR, '3000000'],
    ]);
    expect((await listHolders(cdb, T_NEW)).find((h) => h.holder === TRADER)?.balance_raw).toBe((10n ** 23n).toString());

    // Nothing of the old deployment moved, no alert went out for history, and the cursor stayed.
    expect(await count('SELECT count(*) AS n FROM swaps WHERE token = $1', [T_OLD.toLowerCase()])).toBe(before.oldSwaps);
    expect(await count('SELECT count(*) AS n FROM transfers WHERE token = $1', [T_OLD.toLowerCase()])).toBe(before.oldTransfers);
    expect(await listHolders(cdb, T_OLD)).toEqual(before.oldHolders);
    expect(await countPendingAlerts(cdb)).toBe(before.alerts);
    expect(await readCursor(cdb)).toEqual(before.cursor);
    expect(await readIndexedDeployments(cdb)).toEqual([
      { factory: FACTORY, caught_up_through: '1024' },
      { factory: NEW.factory, caught_up_through: '1024' },
    ]);

    // Done once: a restart does not read anything again.
    c.calls = [];
    expect(await catchUpDeployments({ db: cdb, chain: c, deployments: [OLD, NEW], maxRange: 7 })).toEqual([]);
    expect(c.calls).toEqual([]);
  });

  it('then carries on with both deployments in the main pass, alerts included', async () => {
    const alerts = await countPendingAlerts(cdb);
    addRouterBuy(c, 1_026n, { hook: NEW.hook, token: T_NEW, poolId: P_NEW, to: TRADER, stockIn: 10_000_000n, tokensOut: 10n ** 22n, txHash: txOf('new-buy-2') });
    addRouterBuy(c, 1_027n, { hook: OLD.hook, token: T_OLD, poolId: P_OLD, to: TRADER, stockIn: 10_000_000n, tokensOut: 10n ** 22n, txHash: txOf('old-buy-2') });
    c.head = 1_040n;

    expect(await syncOnce({ db: cdb, chain: c, deployments: [OLD, NEW], confirmations: 6, maxRange: 50 })).toMatchObject({
      status: 'progressed',
      fromBlock: 1_025n,
      toBlock: 1_034n,
      swaps: 2,
      deploymentsBehind: [],
    });
    expect(await countPendingAlerts(cdb)).toBe(alerts + 2);
    expect(await listSwaps(cdb, { token: T_NEW })).toHaveLength(3);
    expect(await listSwaps(cdb, { token: T_OLD })).toHaveLength(2);
    // What each deployment has indexed moves with the cursor, in the same transaction.
    expect(await readIndexedDeployments(cdb)).toEqual([
      { factory: FACTORY, caught_up_through: '1034' },
      { factory: NEW.factory, caught_up_through: '1034' },
    ]);
  });

  it('reruns a pass that failed partway, without doubling what the first attempt wrote', async () => {
    addLaunch(c, 1_021n, { deployment: NEWER, token: T_NEWER, poolId: P_NEWER, creator: CREATOR, txHash: txOf('newer-launch') });
    addRouterBuy(c, 1_028n, { hook: NEWER.hook, token: T_NEWER, poolId: P_NEWER, to: TRADER, stockIn: 20_000_000n, tokensOut: 10n ** 22n, txHash: txOf('newer-buy') });
    c.senders.set(txOf('newer-buy'), TRADER);
    const deployments = [OLD, NEW, NEWER];

    // Windows of five over [1020, 1034]: the first commits the launch, the second's read fails.
    c.calls = [];
    c.failOnCall = 4;
    await expect(catchUpDeployments({ db: cdb, chain: c, deployments, maxRange: 5 })).rejects.toThrow('rpc dropped');
    c.failOnCall = null;
    expect(await readMarket(cdb, T_NEWER)).not.toBeNull();
    expect((await readIndexedDeployments(cdb)).map((row) => row.factory)).not.toContain(NEWER.factory);

    expect(await catchUpDeployments({ db: cdb, chain: c, deployments, maxRange: 5 })).toEqual([NEWER]);
    expect(await listSwaps(cdb, { token: T_NEWER })).toHaveLength(1);
    expect((await listHolders(cdb, T_NEWER)).find((h) => h.holder === TRADER)?.balance_raw).toBe((10n ** 22n).toString());
    expect(await readIndexedDeployments(cdb)).toContainEqual({ factory: NEWER.factory, caught_up_through: '1034' });
  });
});

// -------------------------------------------------------------------------------------------------
// The deployment list, checked against the database and the chain
// -------------------------------------------------------------------------------------------------

describe('the deployment list against the database and the chain', () => {
  /** Both deployments live: an old launch and its trade, a new launch with its buy. */
  function liveChain(): FakeChain {
    const c = new FakeChain().wire(OLD, NEW);
    addLaunch(c, 1_010n, { deployment: OLD, token: T_OLD, poolId: P_OLD, creator: CREATOR, txHash: txOf('old-launch') });
    addLaunch(c, 1_011n, { deployment: NEW, token: T_NEW, poolId: P_NEW, creator: CREATOR, txHash: txOf('new-launch'), buy: NEW_BUY });
    c.senders.set(txOf('new-launch'), CREATOR);
    addRouterBuy(c, 1_012n, { hook: OLD.hook, token: T_OLD, poolId: P_OLD, to: TRADER, stockIn: 100_000_000n, tokensOut: 10n ** 24n, txHash: txOf('old-buy') });
    c.senders.set(txOf('old-buy'), TRADER);
    c.head = 1_030n;
    return c;
  }

  /**
   * A database as a release from before launches recorded their deployment leaves it: indexed to
   * block 1024 following `followed`, no launch stamped, nothing in indexed_deployments.
   */
  async function legacyDb(c: FakeChain, followed: StockPairDeployment[]): Promise<Db> {
    const ldb = await freshDb();
    expect(await syncOnce({ db: ldb, chain: c, deployments: followed, confirmations: 6, maxRange: 50 })).toMatchObject({
      status: 'progressed',
      toBlock: 1_024n,
    });
    await ldb.query('UPDATE launches SET factory = NULL, hook = NULL');
    return ldb;
  }

  const stamps = (d: Db) =>
    d.query<{ token: string; factory: string | null; hook: string | null }>('SELECT token, factory, hook FROM launches ORDER BY token');
  const OLD_STAMP = { token: T_OLD.toLowerCase(), factory: OLD.factory.toLowerCase(), hook: OLD.hook.toLowerCase() };
  const NEW_STAMP = { token: T_NEW.toLowerCase(), factory: NEW.factory.toLowerCase(), hook: NEW.hook.toLowerCase() };

  it('stamps each stored launch with the factory its own receipt names, not the first in the list', async () => {
    const c = liveChain();
    // Launches from both deployments, as an older release pointed at each in turn would leave them.
    const ldb = await legacyDb(c, [OLD, NEW]);
    try {
      const alerts = await countPendingAlerts(ldb);
      const oldSwaps = await listSwaps(ldb, { token: T_OLD });
      const passed = await catchUpDeployments({ db: ldb, chain: c, deployments: [OLD, NEW], maxRange: 50 });
      expect(await stamps(ldb)).toEqual([OLD_STAMP, NEW_STAMP]);
      expect(c.checks.filter((check) => check.startsWith('launchOf'))).toEqual([]);
      // Nothing says which one the cursor followed, so both were read again from their deploy
      // blocks: that rewrites nothing already there and announces nothing.
      expect(passed).toEqual([OLD, NEW]);
      expect(await listSwaps(ldb, { token: T_OLD })).toEqual(oldSwaps);
      expect(await countPendingAlerts(ldb)).toBe(alerts);
      expect(await readIndexedDeployments(ldb)).toEqual([
        { factory: OLD.factory, caught_up_through: '1024' },
        { factory: NEW.factory, caught_up_through: '1024' },
      ]);
    } finally {
      await ldb.close();
    }
  });

  it("asks each factory's launchOf when the node has no receipt for the launch", async () => {
    const c = liveChain();
    c.missingReceipts.add(txOf('old-launch'));
    const ldb = await legacyDb(c, [OLD]);
    try {
      expect(await catchUpDeployments({ db: ldb, chain: c, deployments: [OLD, NEW], maxRange: 50 })).toEqual([NEW]);
      expect(await stamps(ldb)).toEqual([OLD_STAMP, NEW_STAMP]);
      expect(c.checks).toContain(`launchOf ${OLD.factory} ${T_OLD.toLowerCase()}`);
      // The cursor followed the old deployment alone, so only the new one needed a pass.
      expect(await readIndexedDeployments(ldb)).toEqual([
        { factory: OLD.factory, caught_up_through: '1024' },
        { factory: NEW.factory, caught_up_through: '1024' },
      ]);
    } finally {
      await ldb.close();
    }
  });

  it('refuses, and labels nothing, when the list leaves out the deployment stored launches came from', async () => {
    const c = liveChain();
    const ldb = await legacyDb(c, [OLD]);
    try {
      // Single keys moved to the new deployment by habit: the list is [NEW] alone.
      const refused = catchUpDeployments({ db: ldb, chain: c, deployments: [NEW], maxRange: 50 });
      await expect(refused).rejects.toThrow(DeploymentMismatchError);
      await expect(refused).rejects.toThrow(`${T_OLD.toLowerCase()} (tx ${txOf('old-launch')}) was launched by ${OLD.factory}`);
      // Without a receipt the factories are asked, and none listed made it.
      c.missingReceipts.add(txOf('old-launch'));
      await expect(catchUpDeployments({ db: ldb, chain: c, deployments: [NEW], maxRange: 50 })).rejects.toThrow(
        'was launched by no listed factory',
      );
      expect(await stamps(ldb)).toEqual([{ token: T_OLD.toLowerCase(), factory: null, hook: null }]);
      expect(await readIndexedDeployments(ldb)).toEqual([]);
      expect(await readCursor(ldb)).toMatchObject({ next_block: '1025' });
    } finally {
      await ldb.close();
    }
  });

  it('refuses a list that drops a deployment the database has indexed', async () => {
    const c = liveChain();
    const ddb = await freshDb();
    try {
      await catchUpDeployments({ db: ddb, chain: c, deployments: [OLD, NEW], maxRange: 50 });
      await expect(catchUpDeployments({ db: ddb, chain: c, deployments: [NEW], maxRange: 50 })).rejects.toThrow(
        `the database has indexed factory ${OLD.factory}, which STOCKPAIR_DEPLOYMENTS no longer lists`,
      );
      await expect(catchUpDeployments({ db: ddb, chain: c, deployments: [OLD], maxRange: 50 })).rejects.toThrow(DeploymentMismatchError);
      // Putting it back is all it takes.
      expect(await catchUpDeployments({ db: ddb, chain: c, deployments: [OLD, NEW], maxRange: 50 })).toEqual([]);
    } finally {
      await ddb.close();
    }
  });

  it('refuses a factory the chain wires to another hook, and holds at an address with no factory', async () => {
    const c = liveChain();
    const ldb = await legacyDb(c, [OLD]);
    try {
      const typo = { ...NEW, hook: '0x00000000000000000000000000000000000000c9' as Address };
      await expect(catchUpDeployments({ db: ldb, chain: c, deployments: [OLD, typo], maxRange: 50 })).rejects.toThrow(
        `factory ${NEW.factory} is wired to ${NEW.hook}, not the listed hook ${typo.hook}`,
      );
      // No code at all may be a node behind a fresh deployment: an ordinary error, retried each poll.
      const nowhere = { ...NEW, factory: '0x00000000000000000000000000000000000000f9' as Address };
      const retried = catchUpDeployments({ db: ldb, chain: c, deployments: [OLD, nowhere], maxRange: 50 });
      await expect(retried).rejects.toThrow(`No factory code at ${nowhere.factory}`);
      await expect(retried).rejects.not.toThrow(DeploymentMismatchError);
      expect(await stamps(ldb)).toEqual([{ token: T_OLD.toLowerCase(), factory: null, hook: null }]);
    } finally {
      await ldb.close();
    }
  });

  it('refuses a list out of deploy-block order, or naming a factory or hook twice', async () => {
    const c = liveChain();
    for (const deployments of [[NEW, OLD], [OLD, { ...NEW, hook: OLD.hook }], [OLD, { ...OLD, hook: NEW.hook }], []]) {
      await expect(catchUpDeployments({ db, chain: c, deployments, maxRange: 50 })).rejects.toThrow(DeploymentMismatchError);
    }
    expect(c.checks).toEqual([]);
  });

  it('reads what the cursor moved over while the catch-up ran, and announces none of it', async () => {
    const c = liveChain();
    const ldb = await legacyDb(c, [OLD]);
    try {
      addRouterBuy(c, 1_027n, { hook: NEW.hook, token: T_NEW, poolId: P_NEW, to: TRADER, stockIn: 50_000_000n, tokensOut: 10n ** 23n, txHash: txOf('new-buy-late') });
      c.senders.set(txOf('new-buy-late'), TRADER);
      c.head = 1_040n;
      const alerts = await countPendingAlerts(ldb);
      // An old container still draining indexes [1025, 1029] with the old deployment only, while the
      // new deployment's pass is under way.
      c.beforeNextGetLogs = () => writeCursor(ldb, 1_030n, c.hashOf(1_029n));

      expect(await catchUpDeployments({ db: ldb, chain: c, deployments: [OLD, NEW], maxRange: 50 })).toEqual([OLD, NEW]);
      expect((await listSwaps(ldb, { token: T_NEW })).map((s) => [s.block_number, s.trader])).toEqual([
        ['1027', TRADER],
        ['1011', CREATOR],
      ]);
      expect(await readIndexedDeployments(ldb)).toEqual([
        { factory: OLD.factory, caught_up_through: '1029' },
        { factory: NEW.factory, caught_up_through: '1029' },
      ]);
      expect(await countPendingAlerts(ldb)).toBe(alerts);
      expect(await readCursor(ldb)).toMatchObject({ next_block: '1030' });
    } finally {
      await ldb.close();
    }
  });

  it('keeps a stretch an older release indexed without a deployment, and reads it on the next start', async () => {
    const c = liveChain();
    const ddb = await freshDb();
    try {
      await catchUpDeployments({ db: ddb, chain: c, deployments: [OLD, NEW], maxRange: 50 });
      await syncOnce({ db: ddb, chain: c, deployments: [OLD, NEW], confirmations: 6, maxRange: 50 });
      expect((await readIndexedDeployments(ddb)).map((row) => row.caught_up_through)).toEqual(['1024', '1024']);

      // Rolled back to a release that follows the old deployment's single keys and knows nothing
      // of indexed_deployments: it moves the cursor over a new-deployment trade it never reads.
      addRouterBuy(c, 1_030n, { hook: NEW.hook, token: T_NEW, poolId: P_NEW, to: TRADER, stockIn: 50_000_000n, tokensOut: 10n ** 23n, txHash: txOf('new-buy-missed') });
      c.senders.set(txOf('new-buy-missed'), TRADER);
      await writeCursor(ddb, 1_035n, c.hashOf(1_034n));

      // Back on this release, the main pass carries on but moves neither deployment past the hole,
      // and says which ones it left there so the loop runs their catch-up before its next pass.
      c.head = 1_045n;
      expect(await syncOnce({ db: ddb, chain: c, deployments: [OLD, NEW], confirmations: 6, maxRange: 50 })).toMatchObject({
        status: 'progressed',
        fromBlock: 1_035n,
        toBlock: 1_039n,
        deploymentsBehind: [OLD.factory, NEW.factory].map((f) => f.toLowerCase()).sort(),
      });
      expect((await readIndexedDeployments(ddb)).map((row) => row.caught_up_through)).toEqual(['1024', '1024']);

      // The catch-up (the next start's, or the loop's right away) reads the hole for both.
      expect(await catchUpDeployments({ db: ddb, chain: c, deployments: [OLD, NEW], maxRange: 50 })).toEqual([OLD, NEW]);
      expect((await listSwaps(ddb, { token: T_NEW })).map((s) => s.block_number)).toContain('1030');
      expect((await readIndexedDeployments(ddb)).map((row) => row.caught_up_through)).toEqual(['1039', '1039']);
    } finally {
      await ddb.close();
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The metadata backfill stays off the sync's critical path
// -------------------------------------------------------------------------------------------------

describe('metadata backfill limits', () => {
  let mdb: Db;
  const GATEWAY = 'https://gw.test';

  async function pending(token: Address, launchedAt: Date, attempts = 0) {
    await insertLaunch(mdb, {
      token,
      stock: NVDAc,
      creator: CREATOR,
      poolId: `0x${token.slice(-2).repeat(32)}`,
      tokenIsCurrency0: true,
      name: 'Pending',
      symbol: 'PEND',
      contractUri: `ipfs://bafy${token.slice(-2)}`,
      openingSqrtPriceX96: OPENING_SQRT,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n,
      blockNumber: 1_010n,
      blockHash: '0xb',
      txHash: txOf(`pending-${token}`),
      logIndex: 0,
      launchedAt,
    });
    await mdb.query('UPDATE launches SET metadata_attempts = $2 WHERE token = $1', [token.toLowerCase(), attempts]);
  }

  beforeAll(async () => {
    mdb = await freshDb();
  });
  afterAll(async () => {
    await mdb.close();
  });

  it('starts no fetch that could run past its time budget, and tries never-failed URIs first', async () => {
    await pending('0xb2000000000000000000000000000000000000d1', new Date('2026-09-01T00:00:00Z'));
    await pending('0xb2000000000000000000000000000000000000d2', new Date('2026-09-02T00:00:00Z'), 1);
    await pending('0xb2000000000000000000000000000000000000d3', new Date('2026-09-03T00:00:00Z'));
    let clock = 0;
    const requested: string[] = [];
    // Every fetch hangs until its timeout: ten seconds of the fake clock.
    const hanging = (async (input: string | URL | Request) => {
      requested.push(String(input).slice(`${GATEWAY}/ipfs/`.length));
      clock += 10_000;
      return new Response('timeout', { status: 504 });
    }) as typeof fetch;

    expect(await backfillMetadata(mdb, GATEWAY, hanging, { budgetMs: 25_000, now: () => clock })).toBe(0);
    // Two fit in 25 s; the one that already failed once waits behind both, newest first.
    expect(requested).toEqual(['bafyd3', 'bafyd1']);
  });

  it('runs one backfill at a time beside the sync, and only logs its failures', async () => {
    const logged: string[] = [];
    let finish!: (filled: number) => void;
    let runs = 0;
    const worker = metadataWorker(
      (limit) => {
        runs += 1;
        if (limit === 0) return Promise.reject(new Error('gateway down'));
        return new Promise<number>((resolve) => (finish = resolve));
      },
      (message) => logged.push(message),
    );
    expect(worker.kick(20)).toBe(true);
    expect(worker.kick(5)).toBe(false); // one in flight: asking again does nothing
    finish(2);
    await worker.settled();
    expect(logged).toEqual(['metadata filled']);
    expect(worker.kick(0)).toBe(true);
    await worker.settled();
    expect(logged).toEqual(['metadata filled', 'metadata backfill failed']);
    expect(runs).toBe(2);
  });

  // A profile whose first fetch failed (a document pinned seconds earlier that the gateway did not
  // serve yet) used to stay unfilled for good: the worker only ran on new launches, profile changes
  // or an idle poll, and Base never idles.
  it('runs on its own clock so a failed fetch is retried once its backoff has passed', async () => {
    const limits: number[] = [];
    const worker = metadataWorker(async (limit) => (limits.push(limit), 0), () => undefined, { retryEveryMs: 60_000 });
    expect(worker.kickIfDue(20, 0)).toBe(true);
    await worker.settled();
    expect(worker.kickIfDue(20, 30_000)).toBe(false); // too soon
    expect(worker.kickIfDue(20, 59_999)).toBe(false);
    expect(worker.kickIfDue(20, 60_000)).toBe(true);
    await worker.settled();
    // An event-driven kick counts too: it resets the clock rather than doubling up.
    expect(worker.kick(5, 100_000)).toBe(true);
    await worker.settled();
    expect(worker.kickIfDue(20, 150_000)).toBe(false);
    expect(worker.kickIfDue(20, 160_000)).toBe(true);
    await worker.settled();
    expect(limits).toEqual([20, 20, 5, 20]);
  });
});
