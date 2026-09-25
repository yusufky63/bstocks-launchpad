import type { Address, Hex } from 'viem';

import {
  BASE_CONTRACTS,
  classifySwap,
  decodeContractURIChanged,
  decodeCreatorBought,
  decodeFeeCharged,
  decodeFeesClaimed,
  decodeLaunched,
  decodeMetadataEditable,
  decodeMetadataLocked,
  decodeSwap,
  decodeTransfer,
  e30ToDecimalString,
  ERC20_TRANSFER_TOPIC,
  openingPriceUsd,
  stockPerTokenE30,
  SUPPLY_RAW,
  UNISWAP_V4_SWAP_TOPIC,
  type CreatorBoughtEvent,
  type LaunchedEvent,
  type RawLog,
  type StockPairDeployment,
} from '@stockpair/core';
import {
  addSwapFees,
  advanceIndexedDeployments,
  applyBalanceDeltas,
  enqueueAlerts,
  insertFeeClaims,
  insertFeeEvents,
  insertLaunches,
  insertMetadataUpdates,
  insertSwaps,
  insertTransfers,
  listUnstampedLaunches,
  markDeploymentIndexed,
  readBlockHash,
  readCursor,
  readIndexedDeployments,
  rebuildCandles,
  restoreArchivedProfiles,
  rollbackFrom,
  sanitizeText,
  stampLaunchDeployment,
  upsertBlocks,
  writeCursor,
  type AlertInsert,
  type BalanceDelta,
  type Db,
  type FeeClaimInsert,
  type FeeEventInsert,
  type LaunchInsert,
  type MetadataUpdateInsert,
  type SwapInsert,
  type TransferInsert,
  type UnstampedLaunchRow,
} from '@stockpair/core/db';

import type { ChainReader } from './chain-reader';

type Logger = (message: string, fields?: Record<string, unknown>) => void;

export type SyncOptions = Readonly<{
  db: Db;
  chain: ChainReader;
  /** Every deployment, oldest first. All stay live, so every factory and hook is read. */
  deployments: readonly StockPairDeployment[];
  confirmations: number;
  maxRange: number;
  /** Deepest reorg the indexer will walk back looking for a common ancestor. */
  maxReorgDepth?: number;
  log?: Logger;
}>;

export type SyncResult =
  | { status: 'idle'; nextBlock: bigint; safeBlock: bigint }
  | {
      status: 'progressed';
      fromBlock: bigint;
      toBlock: bigint;
      launches: number;
      swaps: number;
      transfers: number;
      /** Onchain profile changes (new contract URIs and locks) that were new to the database. */
      metadataUpdates: number;
      /**
       * Factories whose indexed range did not reach this pass: a second writer moved the cursor
       * over blocks nobody read for them. The caller runs their catch-up before the next pass.
       */
      deploymentsBehind: readonly string[];
    }
  | { status: 'reorg'; rolledBackTo: bigint };

type PoolInfo = {
  token: Address;
  stock: Address;
  tokenIsCurrency0: boolean;
  stockDecimals: number;
  creator: Address;
  /** The factory that launched the pool. NULL only on a row not yet backfilled. */
  factory: Address | null;
};

/** A swap row plus whether it is the creator's buy inside launchAndBuy. */
type IndexedSwap = SwapInsert & { launchBuy: boolean };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function loadPools(db: Db, factory?: Address): Promise<Map<string, PoolInfo>> {
  const rows = await db.query<{
    pool_id: string;
    token: string;
    stock: string;
    token_is_currency0: boolean;
    creator: string;
    factory: string | null;
    decimals: number;
  }>(
    `SELECT l.pool_id, l.token, l.stock, l.token_is_currency0, l.creator, l.factory, s.decimals
     FROM launches l JOIN stocks s ON s.address = l.stock
     ${factory ? 'WHERE l.factory = $1' : ''}`,
    factory ? [factory.toLowerCase()] : [],
  );
  const pools = new Map<string, PoolInfo>();
  for (const row of rows) {
    pools.set(row.pool_id.toLowerCase(), {
      token: row.token as Address,
      stock: row.stock as Address,
      tokenIsCurrency0: row.token_is_currency0,
      stockDecimals: Number(row.decimals),
      creator: row.creator as Address,
      factory: row.factory as Address | null,
    });
  }
  return pools;
}

/** A launch's CreatorBought is in its own transaction and names its pool; this is the key for both. */
function buyKey(txHash: string, poolId: string): string {
  return `${txHash.toLowerCase()}|${poolId.toLowerCase()}`;
}

/**
 * Queues what happened for the alert channel.
 *
 * Deliberately unfiltered: every launch and every swap goes in, and the alerts service decides
 * what is worth posting. Policy — thresholds, which kinds are announced at all — changes far more
 * often than this loop should, and this loop is the one process that must never break.
 *
 * The stock's USD price is read here rather than at send time because a post has to say what a
 * trade was worth when it happened, not when the dispatcher got round to it. For the same reason a
 * launch carries its opening price: a buy in the launch transaction has already moved the last
 * trade price by the time the post is written.
 */
async function queueAlerts(
  tx: Db,
  launches: readonly LaunchInsert[],
  swaps: readonly IndexedSwap[],
  pools: Map<string, PoolInfo>,
  creatorBuys: ReadonlyMap<string, CreatorBoughtEvent>,
): Promise<void> {
  if (launches.length === 0 && swaps.length === 0) return;

  const stocks = [...new Set([...launches.map((l) => l.stock), ...swaps.map((s) => pools.get(s.poolId.toLowerCase())?.stock ?? '')])]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
  const quotes = new Map<string, string>();
  if (stocks.length > 0) {
    const rows = await tx.query<{ stock: string; price_usd8: string }>(
      'SELECT stock, price_usd8 FROM stock_quotes WHERE stock = ANY($1::text[])',
      [stocks],
    );
    for (const row of rows) quotes.set(row.stock.toLowerCase(), row.price_usd8);
  }

  const alerts: AlertInsert[] = [];
  for (const l of launches) {
    const pool = pools.get(l.poolId.toLowerCase());
    if (!pool) continue;
    const bought = creatorBuys.get(buyKey(l.txHash, l.poolId));
    alerts.push({
      kind: 'launch',
      token: l.token,
      blockNumber: l.blockNumber,
      dedupeKey: `launch:${l.token.toLowerCase()}`,
      payload: {
        name: l.name,
        symbol: l.symbol,
        creator: l.creator.toLowerCase(),
        stock: l.stock.toLowerCase(),
        stockUsd8: l.stockUsd8.toString(),
        txHash: l.txHash,
        launchedAt: l.launchedAt.toISOString(),
        openingPriceUsd: openingPriceUsd(l.openingSqrtPriceX96, l.tokenIsCurrency0, pool.stockDecimals, l.stockUsd8),
        creatorBuy: bought
          ? {
              stockInRaw: bought.stockIn.toString(),
              feeRaw: bought.fee.toString(),
              tokensOutRaw: bought.tokensOut.toString(),
              supplyBps: Number((bought.tokensOut * 10_000n) / SUPPLY_RAW),
            }
          : null,
        metadataEditable: l.metadataEditable ?? false,
      },
    });
  }
  for (const s of swaps) {
    const pool = pools.get(s.poolId.toLowerCase());
    if (!pool) continue;
    const stock = pool.stock.toLowerCase();
    alerts.push({
      kind: 'trade',
      token: s.token,
      blockNumber: s.blockNumber,
      dedupeKey: `trade:${s.txHash.toLowerCase()}:${s.logIndex}`,
      payload: {
        side: s.side,
        amountTokenRaw: s.amountTokenRaw.toString(),
        amountStockRaw: s.amountStockRaw.toString(),
        priceTokenInStock: s.priceTokenInStock,
        trader: s.trader?.toLowerCase() ?? null,
        txHash: s.txHash,
        logIndex: s.logIndex,
        blockTime: s.blockTime.toISOString(),
        stock,
        stockDecimals: pool.stockDecimals,
        stockUsd8: quotes.get(stock) ?? null,
        launchBuy: s.launchBuy,
      },
    });
  }
  await enqueueAlerts(tx, alerts);
}

/** How many RPC reads may be outstanding at once; the transport batches whatever overlaps. */
const RPC_CONCURRENCY = 100;

/**
 * Reads every item with a bounded number of requests in flight, in input order. A range with real
 * volume references hundreds of blocks and swap transactions, and asking for them one at a time is
 * hundreds of round trips before a single row is written.
 */
async function inFlight<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += RPC_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + RPC_CONCURRENCY).map((item) => read(item)))));
  }
  return out;
}

/** Where a fresh database starts: the oldest deploy block. */
function firstDeployBlock(deployments: readonly StockPairDeployment[]): bigint {
  const [first, ...rest] = deployments;
  if (!first) throw new Error('No StockPair deployment to index.');
  return rest.reduce((min, d) => (d.deployBlock < min ? d.deployBlock : min), first.deployBlock);
}

/** One bounded synchronisation step. Safe to call repeatedly; never processes unconfirmed blocks. */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
  const { db, chain, deployments } = options;
  const log = options.log ?? (() => undefined);
  const floor = firstDeployBlock(deployments);
  const head = await chain.getBlockNumber();
  const safe = head - BigInt(options.confirmations);

  const cursor = await readCursor(db);
  const next = cursor ? BigInt(cursor.next_block) : floor;

  // Reorg check: the last processed block must still be canonical.
  if (cursor?.last_block_hash && next > floor) {
    const lastNumber = next - 1n;
    const onchain = await chain.getBlock(lastNumber);
    if (onchain.hash.toLowerCase() !== cursor.last_block_hash.toLowerCase()) {
      const ancestor = await findCommonAncestor(db, chain, lastNumber, options.maxReorgDepth ?? 200, floor);
      if (ancestor === null) {
        // We could not find where the chains diverge within the search depth. Rolling back on a
        // guess would delete far more than the reorg touched, so stop instead and let a human look.
        log('reorg depth exhausted', { lastNumber: lastNumber.toString(), maxDepth: options.maxReorgDepth ?? 200 });
        return { status: 'idle', nextBlock: next, safeBlock: safe };
      }
      const rollbackTo = ancestor + 1n;
      log('reorg detected', { lastNumber: lastNumber.toString(), rollbackTo: rollbackTo.toString() });
      // Read the hash before touching anything, then undo and re-point the cursor together. Doing
      // the rollback, an RPC call and the cursor write as three steps leaves the cursor past rows
      // that no longer exist if the middle one fails, and a hole that is never re-read.
      const ancestorHash = ancestor >= floor ? (await chain.getBlock(ancestor)).hash : null;
      await db.transaction(async (tx) => {
        await rollbackFrom(tx, rollbackTo);
        await writeCursor(tx, rollbackTo, ancestorHash);
      });
      return { status: 'reorg', rolledBackTo: rollbackTo };
    }
  }

  if (next > safe) return { status: 'idle', nextBlock: next, safeBlock: safe };
  const to = next + BigInt(options.maxRange - 1) < safe ? next + BigInt(options.maxRange - 1) : safe;

  const counts = await indexRange(db, chain, log, next, to, {
    deployments,
    pools: await loadPools(db),
    alerts: true,
    cursor: true,
  });
  return { status: 'progressed', fromBlock: next, toBlock: to, ...counts };
}

/** A pass that found new launches or a new contract URI leaves profiles to fetch. */
export function needsMetadataFetch(result: SyncResult): boolean {
  return result.status === 'progressed' && (result.launches > 0 || result.metadataUpdates > 0);
}

export type CatchUpOptions = Readonly<{
  db: Db;
  chain: ChainReader;
  deployments: readonly StockPairDeployment[];
  maxRange: number;
  log?: Logger;
}>;

/**
 * The deployment list disagrees with the database or the chain. No retry fixes that, so the indexer
 * stops rather than index, or label launches, against a list it cannot trust.
 */
export class DeploymentMismatchError extends Error {
  override name = 'DeploymentMismatchError';
}

/** How often the catch-up follows a cursor that something else keeps moving before it gives up. */
const MAX_CATCH_UP_ROUNDS = 20;

/**
 * Checks the deployment list against the database and the chain, then brings every deployment up
 * to the main cursor. Run before the main loop moves the cursor.
 *
 * Refuses (DeploymentMismatchError) when the list drops a deployment the database has indexed, when
 * a factory is not wired to the hook the list gives it, or when a launch stored without its
 * deployment was not made by any listed factory. Those launches -- indexed before rows recorded
 * their deployment, or by an older release after a rollback -- are stamped with the factory that
 * emitted their Launched log, read back from the chain, never with a guess from list position.
 *
 * The main pass reads every factory and hook from the cursor on, so a deployment whose indexed
 * range stops short of the cursor -- added below it, or skipped while an older release ran -- has a
 * stretch nobody read. It gets a pass of its own over exactly that, reading only its own factory and
 * hook and the pools and tokens those reveal. The pass queues no alerts, since what it finds is
 * history by the time it runs. If the cursor moves while it runs, the stretch the cursor moved over
 * is read too, until the two meet.
 *
 * A deployment's `indexed_deployments` row moves only after its pass has committed, so a crash
 * midway reruns the pass. Every write it makes is idempotent. Returns the deployments that needed
 * a pass.
 */
export async function catchUpDeployments(options: CatchUpOptions): Promise<StockPairDeployment[]> {
  const { db, chain, deployments } = options;
  const log = options.log ?? (() => undefined);
  checkDeploymentList(deployments);

  const recorded = await readIndexedDeployments(db);
  const listed = new Set(deployments.map((d) => d.factory.toLowerCase()));
  const dropped = recorded.filter((row) => !listed.has(row.factory.toLowerCase()));
  if (dropped.length > 0) {
    throw new DeploymentMismatchError(
      `Refusing to start: the database has indexed factory ${dropped.map((row) => row.factory).join(', ')}, which ` +
        'STOCKPAIR_DEPLOYMENTS no longer lists. Earlier deployments stay live, so their launches, fees and claims ' +
        'would stop being indexed. List every deployment ever made, oldest first, and restart.',
    );
  }
  await checkHooks(chain, deployments);
  await stampLaunches(db, chain, deployments, log);

  const cursor = await readCursor(db);
  if (cursor !== null && recorded.length === 0) {
    // A cursor and no rows at all is a database indexed before deployments were tracked, by a
    // release that followed one deployment. Its launches, now stamped from the chain, say which one:
    // that deployment is indexed through the cursor already. With no launch to go by, or launches
    // from several, nothing is assumed and every deployment is read from its deploy block.
    const followed = await db.query<{ factory: string }>('SELECT DISTINCT factory FROM launches WHERE factory IS NOT NULL');
    if (followed.length === 1) {
      await markDeploymentIndexed(db, followed[0]!.factory, BigInt(cursor.next_block) - 1n);
      log('database indexed before deployments were tracked', { followed: followed[0]!.factory });
    } else {
      log('database indexed before deployments were tracked, by no single deployment; reading all', {
        factories: followed.map((row) => row.factory),
      });
    }
  }

  const passed = new Set<StockPairDeployment>();
  for (let round = 1; ; round += 1) {
    const before = await readCursor(db);
    const through = (before ? BigInt(before.next_block) : firstDeployBlock(deployments)) - 1n;
    const indexed = new Map(
      (await readIndexedDeployments(db)).map((row) => [row.factory.toLowerCase(), BigInt(row.caught_up_through)]),
    );
    for (const deployment of deployments) {
      const done = indexed.get(deployment.factory.toLowerCase());
      const from = done === undefined || done < deployment.deployBlock ? deployment.deployBlock : done + 1n;
      if (from <= through) {
        log('deployment catch-up started', {
          factory: deployment.factory,
          fromBlock: from.toString(),
          toBlock: through.toString(),
        });
        await catchUpDeployment(options, log, deployment, from, through);
        passed.add(deployment);
        log('deployment catch-up finished', { factory: deployment.factory });
      }
      await markDeploymentIndexed(db, deployment.factory, through);
    }
    // Only this process should move the cursor, but a second writer (an old container still
    // draining during a deploy) may have. What it covered, it covered without these passes.
    const after = await readCursor(db);
    if ((after?.next_block ?? null) === (before?.next_block ?? null)) break;
    if (round >= MAX_CATCH_UP_ROUNDS) {
      throw new Error('The cursor kept moving during the deployment catch-up: another indexer is writing to this database.');
    }
    log('cursor moved during the deployment catch-up; reading the rest', {
      from: before?.next_block ?? null,
      to: after?.next_block ?? null,
    });
  }
  return deployments.filter((d) => passed.has(d));
}

/** Oldest first by deploy block, every factory and hook once. Config refuses anything else too. */
function checkDeploymentList(deployments: readonly StockPairDeployment[]): void {
  if (deployments.length === 0) throw new DeploymentMismatchError('No StockPair deployment to index.');
  const seen = new Set<string>();
  deployments.forEach((d, i) => {
    const previous = deployments[i - 1];
    if (previous && d.deployBlock < previous.deployBlock) {
      throw new DeploymentMismatchError(`Deployment ${d.factory} is listed after a later one; the list goes oldest first.`);
    }
    for (const address of [d.factory, d.hook]) {
      if (seen.has(address.toLowerCase())) throw new DeploymentMismatchError(`${address} is listed twice.`);
      seen.add(address.toLowerCase());
    }
  });
}

/** Every factory must be wired to the hook listed with it: launch rows store that hook for good. */
async function checkHooks(chain: ChainReader, deployments: readonly StockPairDeployment[]): Promise<void> {
  const wired = await Promise.all(deployments.map((d) => chain.readFactoryHook(d.factory)));
  const wrong = deployments.flatMap((d, i) => {
    const actual = wired[i];
    return actual && actual.toLowerCase() !== d.hook.toLowerCase()
      ? [`factory ${d.factory} is wired to ${actual}, not the listed hook ${d.hook}`]
      : [];
  });
  if (wrong.length > 0) {
    throw new DeploymentMismatchError(`Refusing to start: ${wrong.join('; ')}. Fix STOCKPAIR_DEPLOYMENTS and restart.`);
  }
  // No code could be a node a few blocks behind a fresh deployment, so this one is retried rather
  // than fatal; the cursor does not move until it resolves.
  const missing = deployments.filter((_, i) => !wired[i]);
  if (missing.length > 0) {
    throw new Error(
      `No factory code at ${missing.map((d) => d.factory).join(', ')} on this RPC. A mistyped address in ` +
        'STOCKPAIR_DEPLOYMENTS, or a node behind a deployment this recent; retrying.',
    );
  }
}

type LaunchOrigin = { deployment: StockPairDeployment | null; emitter: string | null };

/**
 * Finds, on the chain, the deployment that made each launch stored without one, and records it.
 * The Launched log in the launch's own receipt names the factory; when the node has no receipt,
 * the factory whose launchOf knows the token does. A launch no listed factory made stops the start.
 */
async function stampLaunches(
  db: Db,
  chain: ChainReader,
  deployments: readonly StockPairDeployment[],
  log: Logger,
): Promise<void> {
  const rows = await listUnstampedLaunches(db);
  if (rows.length === 0) return;
  const origins = await inFlight(rows, (row) => launchOrigin(chain, deployments, row));
  const orphans = rows.flatMap((row, i) => (origins[i]!.deployment ? [] : [{ row, emitter: origins[i]!.emitter }]));
  if (orphans.length > 0) {
    const examples = orphans
      .slice(0, 5)
      .map(({ row, emitter }) => `${row.token} (tx ${row.tx_hash}) was launched by ${emitter ?? 'no listed factory'}`);
    throw new DeploymentMismatchError(
      `Refusing to start: ${orphans.length} stored launch(es) were not made by any deployment in STOCKPAIR_DEPLOYMENTS: ` +
        `${examples.join('; ')}${orphans.length > examples.length ? '; ...' : ''}. List every deployment ever made, ` +
        'oldest first, and restart.',
    );
  }
  for (const deployment of deployments) {
    const tokens = rows.filter((_, i) => origins[i]!.deployment === deployment).map((row) => row.token);
    const stamped = await stampLaunchDeployment(db, deployment, tokens);
    if (stamped > 0) log('launches stamped with the deployment that made them', { launches: stamped, factory: deployment.factory });
  }
}

async function launchOrigin(
  chain: ChainReader,
  deployments: readonly StockPairDeployment[],
  row: UnstampedLaunchRow,
): Promise<LaunchOrigin> {
  const logs = await chain.getTransactionLogs(row.tx_hash as Hex);
  const raw = logs?.find((l) => l.logIndex === Number(row.log_index));
  let launched: LaunchedEvent | null = null;
  try {
    launched = raw ? decodeLaunched(raw) : null;
  } catch {
    launched = null;
  }
  if (raw && launched && launched.token.toLowerCase() === row.token.toLowerCase()) {
    const emitter = raw.address.toLowerCase();
    return { deployment: deployments.find((d) => d.factory.toLowerCase() === emitter) ?? null, emitter: raw.address };
  }
  // No receipt, or its log is not this launch: ask each listed factory whether it launched the token.
  const creators = await Promise.all(deployments.map((d) => chain.readLaunchCreator(d.factory, row.token as Address)));
  const makers = deployments.filter((_, i) => {
    const creator = creators[i];
    return creator != null && creator.toLowerCase() !== ZERO_ADDRESS;
  });
  return { deployment: makers.length === 1 ? makers[0]! : null, emitter: null };
}

async function catchUpDeployment(
  options: CatchUpOptions,
  log: Logger,
  deployment: StockPairDeployment,
  first: bigint,
  through: bigint,
): Promise<void> {
  // Pools the pass finds in one window are swapped in the next, so the map carries across windows.
  const pools = await loadPools(options.db, deployment.factory);
  const width = BigInt(options.maxRange);
  for (let from = first; from <= through; from += width) {
    const to = from + width - 1n < through ? from + width - 1n : through;
    await indexRange(options.db, options.chain, log, from, to, {
      deployments: [deployment],
      pools,
      alerts: false,
      cursor: false,
    });
  }
}

type RangeScope = Readonly<{
  /** Deployments whose factory and hook logs this pass reads. */
  deployments: readonly StockPairDeployment[];
  /** Pools whose swaps and tokens this pass reads; launches it finds are added. */
  pools: Map<string, PoolInfo>;
  /** Queue alerts. Off for a catch-up pass: the channel announces what happens, not history. */
  alerts: boolean;
  /** Move the main cursor. Only the main pass owns it. */
  cursor: boolean;
}>;

type RangeCounts = {
  launches: number;
  swaps: number;
  transfers: number;
  metadataUpdates: number;
  deploymentsBehind: readonly string[];
};

type MetadataLog = { raw: RawLog; factory: Address; token: Address } & (
  | { kind: 'uri'; contractUri: string }
  | { kind: 'lock' }
);

/** Reads and writes everything in [from, to] for the deployments and pools in scope, in one transaction. */
async function indexRange(
  db: Db,
  chain: ChainReader,
  log: Logger,
  from: bigint,
  to: bigint,
  scope: RangeScope,
): Promise<RangeCounts> {
  const factories = new Map(scope.deployments.map((d) => [d.factory.toLowerCase(), d]));
  const hooks = new Set(scope.deployments.map((d) => d.hook.toLowerCase()));
  const pools = scope.pools;

  // 1. Factory + hook events.
  const contractLogs = await chain.getLogs({
    address: [...new Set(scope.deployments.flatMap((d) => [d.factory, d.hook]))],
    fromBlock: from,
    toBlock: to,
  });
  const launchedLogs: { log: RawLog; event: LaunchedEvent; deployment: StockPairDeployment }[] = [];
  const creatorBuys = new Map<string, CreatorBoughtEvent>();
  const editable = new Set<string>();
  const metadataLogs: MetadataLog[] = [];
  for (const raw of contractLogs) {
    // Launches and profile events only count from a factory, fees and claims (below) only from a hook.
    const deployment = factories.get(raw.address.toLowerCase());
    if (!deployment) continue;
    const launched = decodeLaunched(raw);
    if (launched) {
      launchedLogs.push({ log: raw, event: launched, deployment });
      const stockDecimals = await stockDecimalsOf(db, launched.stock);
      if (stockDecimals === null) {
        log('launch for unknown stock skipped', { token: launched.token, stock: launched.stock });
        continue;
      }
      pools.set(launched.poolId.toLowerCase(), {
        token: launched.token,
        stock: launched.stock,
        tokenIsCurrency0: launched.token.toLowerCase() < launched.stock.toLowerCase(),
        stockDecimals,
        creator: launched.creator,
        factory: deployment.factory,
      });
      continue;
    }
    if (raw.transactionHash === null) continue;
    const bought = decodeCreatorBought(raw);
    if (bought) {
      creatorBuys.set(buyKey(raw.transactionHash, bought.poolId), bought);
      continue;
    }
    // Always the log right after its Launched, so it lands in the same batch as the launch row.
    const madeEditable = decodeMetadataEditable(raw);
    if (madeEditable) {
      editable.add(`${raw.transactionHash.toLowerCase()}|${madeEditable.token.toLowerCase()}`);
      continue;
    }
    const changed = decodeContractURIChanged(raw);
    if (changed) {
      metadataLogs.push({ raw, factory: deployment.factory, token: changed.token, kind: 'uri', contractUri: changed.contractURI });
      continue;
    }
    const locked = decodeMetadataLocked(raw);
    if (locked) metadataLogs.push({ raw, factory: deployment.factory, token: locked.token, kind: 'lock' });
  }

  // 2. Swaps on known pools and transfers of launched tokens.
  const poolIds = [...pools.keys()] as Hex[];
  const tokens = [...new Set([...pools.values()].map((p) => p.token.toLowerCase()))] as Address[];
  const swapLogs = poolIds.length
    ? await chain.getLogs({
        address: BASE_CONTRACTS.poolManager,
        topics: [UNISWAP_V4_SWAP_TOPIC, poolIds],
        fromBlock: from,
        toBlock: to,
      })
    : [];
  const transferLogs = tokens.length
    ? await chain.getLogs({ address: tokens, topics: [ERC20_TRANSFER_TOPIC], fromBlock: from, toBlock: to })
    : [];

  // 3. Blocks referenced by any log, plus the range end for the cursor hash.
  const blockNumbers = new Set<bigint>(scope.cursor ? [to] : []);
  for (const l of [...contractLogs, ...swapLogs, ...transferLogs]) {
    if (l.blockNumber !== null) blockNumbers.add(l.blockNumber);
  }
  const blocks = new Map<bigint, { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }>();
  for (const block of await inFlight([...blockNumbers], (number) => chain.getBlock(number))) {
    blocks.set(block.number, block);
  }
  const blockTime = (number: bigint) => new Date(Number(blocks.get(number)!.timestamp) * 1000);

  // 4. Transaction senders for swaps.
  const swapTxHashes = [...new Set(swapLogs.map((l) => l.transactionHash).filter((h): h is Hex => h !== null))];
  const senders = new Map<Hex, Address | null>();
  const senderResults = await inFlight(swapTxHashes, (hash) => chain.getTransactionSender(hash));
  swapTxHashes.forEach((hash, i) => senders.set(hash, senderResults[i] ?? null));

  // 5. Everything the range holds, decoded into rows first so each table is written in one
  //    statement. A busy range carries thousands of rows and a round trip per row is what the
  //    database link, not Postgres, charges for.
  const blockRows = [...blocks.values()].map((block) => ({
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: new Date(Number(block.timestamp) * 1000),
  }));

  const launchRows: LaunchInsert[] = [];
  for (const { log: raw, event, deployment } of launchedLogs) {
    const pool = pools.get(event.poolId.toLowerCase());
    if (!pool || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
    launchRows.push({
      token: event.token,
      stock: event.stock,
      creator: event.creator,
      poolId: event.poolId,
      tokenIsCurrency0: pool.tokenIsCurrency0,
      name: event.name,
      symbol: event.symbol,
      contractUri: event.contractURI,
      openingSqrtPriceX96: event.sqrtPriceX96,
      tickLower: event.tickLower,
      tickUpper: event.tickUpper,
      liquidity: event.liquidity,
      stockUsd8: event.stockUsd8,
      blockNumber: raw.blockNumber,
      blockHash: blocks.get(raw.blockNumber)!.hash,
      txHash: raw.transactionHash,
      logIndex: raw.logIndex,
      launchedAt: blockTime(raw.blockNumber),
      metadataEditable: editable.has(`${raw.transactionHash.toLowerCase()}|${event.token.toLowerCase()}`),
      factory: deployment.factory,
      hook: deployment.hook,
    });
  }

  const swapRows: IndexedSwap[] = [];
  const candleBuckets: { token: string; bucket: Date }[] = [];
  const seenBuckets = new Set<string>();
  for (const raw of swapLogs) {
    const swap = decodeSwap(raw);
    if (!swap || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
    const pool = pools.get(swap.poolId.toLowerCase());
    if (!pool) continue;
    const { side, amountTokenRaw, amountStockRaw } = classifySwap(swap, pool.tokenIsCurrency0);
    const priceE30 = stockPerTokenE30(swap.sqrtPriceX96, pool.tokenIsCurrency0, pool.stockDecimals);
    const time = blockTime(raw.blockNumber);
    // The factory calls the PoolManager itself only for the buy inside launchAndBuy. The
    // transaction's sender is whoever paid the gas -- a bundler or relayer for a smart wallet -- so
    // that buy's trader comes from CreatorBought instead.
    const bought = creatorBuys.get(buyKey(raw.transactionHash, swap.poolId));
    const launchBuy =
      bought !== undefined && pool.factory !== null && swap.sender.toLowerCase() === pool.factory.toLowerCase();
    swapRows.push({
      txHash: raw.transactionHash,
      logIndex: raw.logIndex,
      token: pool.token,
      poolId: swap.poolId,
      side,
      sender: swap.sender,
      trader: launchBuy ? bought.creator : (senders.get(raw.transactionHash) ?? null),
      amountTokenRaw,
      amountStockRaw,
      priceTokenInStock: e30ToDecimalString(priceE30),
      sqrtPriceX96: swap.sqrtPriceX96,
      liquidity: swap.liquidity,
      tick: swap.tick,
      feeStockRaw: 0n,
      blockNumber: raw.blockNumber,
      blockHash: blocks.get(raw.blockNumber)!.hash,
      blockTime: time,
      launchBuy,
    });
    const bucket = minuteBucket(time);
    const key = `${pool.token.toLowerCase()}|${bucket.toISOString()}`;
    if (!seenBuckets.has(key)) {
      seenBuckets.add(key);
      candleBuckets.push({ token: pool.token, bucket });
    }
  }

  const feeRows: FeeEventInsert[] = [];
  const claimRows: FeeClaimInsert[] = [];
  // Pair each fee with the swap that produced it. Within one transaction and pool, the hook's fee
  // events and the PoolManager's swaps are both emitted in execution order, so the nth fee belongs
  // to the nth swap. Keying on the transaction and pool alone would hand a route that touches one
  // pool twice the combined total on both of its rows.
  const swapsByPool = new Map<string, typeof swapRows>();
  for (const row of swapRows) {
    const key = `${row.txHash}|${row.poolId.toLowerCase()}`;
    const list = swapsByPool.get(key);
    if (list) list.push(row);
    else swapsByPool.set(key, [row]);
  }
  const feeOrdinal = new Map<string, number>();
  const swapFees: { txHash: string; logIndex: number; poolId: string; feeStockRaw: bigint }[] = [];
  for (const raw of contractLogs) {
    if (raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
    if (!hooks.has(raw.address.toLowerCase())) continue;
    const fee = decodeFeeCharged(raw);
    if (fee) {
      const pool = pools.get(fee.poolId.toLowerCase());
      if (!pool) continue;
      feeRows.push({
        txHash: raw.transactionHash,
        logIndex: raw.logIndex,
        poolId: fee.poolId,
        token: pool.token,
        stock: fee.stock,
        amountRaw: fee.amount,
        creatorRaw: fee.creatorAmount,
        platformRaw: fee.platformAmount,
        feeBps: Number(fee.feeBps),
        blockNumber: raw.blockNumber,
        blockTime: blockTime(raw.blockNumber),
      });
      const pairKey = `${raw.transactionHash}|${fee.poolId.toLowerCase()}`;
      const ordinal = feeOrdinal.get(pairKey) ?? 0;
      feeOrdinal.set(pairKey, ordinal + 1);
      const target = swapsByPool.get(pairKey)?.[ordinal];
      if (target) swapFees.push({ txHash: target.txHash, logIndex: target.logIndex, poolId: fee.poolId, feeStockRaw: fee.amount });
      continue;
    }
    const claim = decodeFeesClaimed(raw);
    if (claim) {
      claimRows.push({
        txHash: raw.transactionHash,
        logIndex: raw.logIndex,
        stock: claim.stock,
        account: claim.account,
        amountRaw: claim.amount,
        blockNumber: raw.blockNumber,
        blockTime: blockTime(raw.blockNumber),
      });
    }
  }

  // Profile changes point at their launch row, so a token that was never indexed -- its launch
  // named a stock we do not list -- has nothing for them to update and they are dropped.
  const tokenPools = new Map([...pools.values()].map((p) => [p.token.toLowerCase(), p]));
  const metadataRows: MetadataUpdateInsert[] = [];
  for (const m of metadataLogs) {
    const pool = tokenPools.get(m.token.toLowerCase());
    if (!pool || (pool.factory !== null && pool.factory.toLowerCase() !== m.factory.toLowerCase())) continue;
    if (m.raw.blockNumber === null || m.raw.transactionHash === null || m.raw.logIndex === null) continue;
    metadataRows.push({
      txHash: m.raw.transactionHash,
      logIndex: m.raw.logIndex,
      token: m.token,
      kind: m.kind,
      // The creator chose this text, so it gets the same cleaning as a launch's.
      contractUri: m.kind === 'uri' ? sanitizeText(m.contractUri) : null,
      blockNumber: m.raw.blockNumber,
      blockTime: blockTime(m.raw.blockNumber),
    });
  }

  const transferRows: TransferInsert[] = [];
  for (const raw of transferLogs) {
    const transfer = decodeTransfer(raw);
    if (!transfer || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
    transferRows.push({
      txHash: raw.transactionHash,
      logIndex: raw.logIndex,
      token: raw.address,
      from: transfer.from,
      to: transfer.to,
      amountRaw: transfer.value,
      blockNumber: raw.blockNumber,
      blockTime: blockTime(raw.blockNumber),
    });
  }

  let transfers = 0;
  let metadataUpdates = 0;
  let deploymentsBehind: string[] = [];
  await db.transaction(async (tx) => {
    await upsertBlocks(tx, blockRows);
    await insertLaunches(tx, launchRows);
    // A rollback parks creator-signed profiles rather than destroying them; if this range replays a
    // launch that was rolled back, its profile becomes valid again and comes back with it.
    if (launchRows.length > 0) await restoreArchivedProfiles(tx, launchRows.map((l) => l.token));
    await insertSwaps(tx, swapRows);
    await insertFeeEvents(tx, feeRows);
    // Fees land on swap rows, so the swaps have to exist first.
    await addSwapFees(tx, swapFees);
    await insertFeeClaims(tx, claimRows);
    // After the launches: each update references its launch row.
    metadataUpdates = await insertMetadataUpdates(tx, metadataRows);

    // Only transfers that were new move balances, so a re-run of the same range cannot double up.
    const inserted = await insertTransfers(tx, transferRows);
    const deltas: BalanceDelta[] = [];
    for (const t of inserted) {
      if (t.amountRaw === 0n) continue;
      if (t.from.toLowerCase() !== ZERO_ADDRESS) {
        deltas.push({ token: t.token, holder: t.from, delta: -t.amountRaw, blockNumber: t.blockNumber });
      }
      if (t.to.toLowerCase() !== ZERO_ADDRESS) {
        deltas.push({ token: t.token, holder: t.to, delta: t.amountRaw, blockNumber: t.blockNumber });
      }
      transfers += 1;
    }
    await applyBalanceDeltas(tx, deltas);

    await rebuildCandles(tx, candleBuckets);
    // Inside the same transaction as the rows it describes: a rollback leaves no announcement of
    // something that never happened, and a commit cannot lose one.
    if (scope.alerts) await queueAlerts(tx, launchRows, swapRows, pools, creatorBuys);
    if (scope.cursor) {
      await writeCursor(tx, to + 1n, blocks.get(to)!.hash);
      // Same transaction as the cursor: what each deployment has indexed moves with it or not at all.
      deploymentsBehind = await advanceIndexedDeployments(tx, scope.deployments.map((d) => d.factory), from, to);
    }
  });

  return { launches: launchRows.length, swaps: swapRows.length, transfers, metadataUpdates, deploymentsBehind };
}

async function stockDecimalsOf(db: Db, stock: Address): Promise<number | null> {
  const rows = await db.query<{ decimals: number }>('SELECT decimals FROM stocks WHERE address = $1', [
    stock.toLowerCase(),
  ]);
  return rows[0] ? Number(rows[0].decimals) : null;
}

async function findCommonAncestor(
  db: Db,
  chain: ChainReader,
  from: bigint,
  maxDepth: number,
  floor: bigint,
): Promise<bigint | null> {
  let number = from;
  for (; number >= floor && from - number <= BigInt(maxDepth); number -= 1n) {
    const stored = await readBlockHash(db, number);
    if (stored === null) continue;
    const onchain = await chain.getBlock(number);
    if (onchain.hash.toLowerCase() === stored.toLowerCase()) return number;
  }
  // Walking all the way down to the deploy block without a match means everything we hold really is
  // orphaned. Running out of depth first means we simply do not know, and the two must not look the
  // same: `blocks` is stored sparsely, so a quiet stretch plus a long catch-up can exhaust the
  // depth, and treating that as "no ancestor" would wipe the database back to the deploy block.
  return number < floor ? floor - 1n : null;
}

export function minuteBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}
