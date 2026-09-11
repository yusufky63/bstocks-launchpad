import type { Address, Hex } from 'viem';

import {
  BASE_CONTRACTS,
  classifySwap,
  decodeFeeCharged,
  decodeFeesClaimed,
  decodeLaunched,
  decodeSwap,
  decodeTransfer,
  e30ToDecimalString,
  ERC20_TRANSFER_TOPIC,
  stockPerTokenE30,
  UNISWAP_V4_SWAP_TOPIC,
  type RawLog,
  type StockPairDeployment,
} from '@stockpair/core';
import {
  addSwapFees,
  applyBalanceDeltas,
  enqueueAlerts,
  insertFeeClaims,
  insertFeeEvents,
  insertLaunches,
  insertSwaps,
  insertTransfers,
  readBlockHash,
  readCursor,
  rebuildCandles,
  rollbackFrom,
  upsertBlocks,
  writeCursor,
  type AlertInsert,
  type BalanceDelta,
  type Db,
  type FeeClaimInsert,
  type FeeEventInsert,
  type LaunchInsert,
  type SwapInsert,
  type TransferInsert,
  restoreArchivedProfiles,
} from '@stockpair/core/db';

import type { ChainReader } from './chain-reader';

export type SyncOptions = Readonly<{
  db: Db;
  chain: ChainReader;
  deployment: StockPairDeployment;
  confirmations: number;
  maxRange: number;
  /** Deepest reorg the indexer will walk back looking for a common ancestor. */
  maxReorgDepth?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}>;

export type SyncResult =
  | { status: 'idle'; nextBlock: bigint; safeBlock: bigint }
  | { status: 'progressed'; fromBlock: bigint; toBlock: bigint; launches: number; swaps: number; transfers: number }
  | { status: 'reorg'; rolledBackTo: bigint };

type PoolInfo = { token: Address; stock: Address; tokenIsCurrency0: boolean; stockDecimals: number };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function loadPools(db: Db): Promise<Map<string, PoolInfo>> {
  const rows = await db.query<{ pool_id: string; token: string; stock: string; token_is_currency0: boolean; decimals: number }>(
    `SELECT l.pool_id, l.token, l.stock, l.token_is_currency0, s.decimals
     FROM launches l JOIN stocks s ON s.address = l.stock`,
  );
  const pools = new Map<string, PoolInfo>();
  for (const row of rows) {
    pools.set(row.pool_id.toLowerCase(), {
      token: row.token as Address,
      stock: row.stock as Address,
      tokenIsCurrency0: row.token_is_currency0,
      stockDecimals: Number(row.decimals),
    });
  }
  return pools;
}

/**
 * Queues what happened for the alert channel.
 *
 * Deliberately unfiltered: every launch and every swap goes in, and the alerts service decides
 * what is worth posting. Policy — thresholds, which kinds are announced at all — changes far more
 * often than this loop should, and this loop is the one process that must never break.
 *
 * The stock's USD price is read here rather than at send time because a post has to say what a
 * trade was worth when it happened, not when the dispatcher got round to it.
 */
async function queueAlerts(
  tx: Db,
  launches: readonly LaunchInsert[],
  swaps: readonly SwapInsert[],
  pools: Map<string, PoolInfo>,
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

/** One bounded synchronisation step. Safe to call repeatedly; never processes unconfirmed blocks. */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
  const { db, chain, deployment } = options;
  const log = options.log ?? (() => undefined);
  const head = await chain.getBlockNumber();
  const safe = head - BigInt(options.confirmations);

  const cursor = await readCursor(db);
  let next = cursor ? BigInt(cursor.next_block) : deployment.deployBlock;

  // Reorg check: the last processed block must still be canonical.
  if (cursor?.last_block_hash && next > deployment.deployBlock) {
    const lastNumber = next - 1n;
    const onchain = await chain.getBlock(lastNumber);
    if (onchain.hash.toLowerCase() !== cursor.last_block_hash.toLowerCase()) {
      const ancestor = await findCommonAncestor(db, chain, lastNumber, options.maxReorgDepth ?? 200, deployment.deployBlock);
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
      const ancestorHash = ancestor >= deployment.deployBlock ? (await chain.getBlock(ancestor)).hash : null;
      await db.transaction(async (tx) => {
        await rollbackFrom(tx, rollbackTo);
        await writeCursor(tx, rollbackTo, ancestorHash);
      });
      return { status: 'reorg', rolledBackTo: rollbackTo };
    }
  }

  if (next > safe) return { status: 'idle', nextBlock: next, safeBlock: safe };
  const to = next + BigInt(options.maxRange - 1) < safe ? next + BigInt(options.maxRange - 1) : safe;

  // 1. Factory + hook events.
  const contractLogs = await chain.getLogs({
    address: [deployment.factory, deployment.hook],
    fromBlock: next,
    toBlock: to,
  });
  const pools = await loadPools(db);
  const launchedLogs: { log: RawLog; event: NonNullable<ReturnType<typeof decodeLaunched>> }[] = [];
  for (const raw of contractLogs) {
    const launched = decodeLaunched(raw);
    if (launched) {
      launchedLogs.push({ log: raw, event: launched });
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
      });
    }
  }

  // 2. Swaps on known pools and transfers of launched tokens.
  const poolIds = [...pools.keys()] as Hex[];
  const tokens = [...new Set([...pools.values()].map((p) => p.token.toLowerCase()))] as Address[];
  const swapLogs = poolIds.length
    ? await chain.getLogs({
        address: BASE_CONTRACTS.poolManager,
        topics: [UNISWAP_V4_SWAP_TOPIC, poolIds],
        fromBlock: next,
        toBlock: to,
      })
    : [];
  const transferLogs = tokens.length
    ? await chain.getLogs({ address: tokens, topics: [ERC20_TRANSFER_TOPIC], fromBlock: next, toBlock: to })
    : [];

  // 3. Blocks referenced by any log, plus the range end for the cursor hash.
  const blockNumbers = new Set<bigint>([to]);
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
  for (const { log: raw, event } of launchedLogs) {
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
    });
  }

  const swapRows: SwapInsert[] = [];
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
    swapRows.push({
      txHash: raw.transactionHash,
      logIndex: raw.logIndex,
      token: pool.token,
      poolId: swap.poolId,
      side,
      sender: swap.sender,
      trader: senders.get(raw.transactionHash) ?? null,
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
    await queueAlerts(tx, launchRows, swapRows, pools);
    await writeCursor(tx, to + 1n, blocks.get(to)!.hash);
  });
  const launches = launchRows.length;
  const swaps = swapRows.length;

  return { status: 'progressed', fromBlock: next, toBlock: to, launches, swaps, transfers };
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
