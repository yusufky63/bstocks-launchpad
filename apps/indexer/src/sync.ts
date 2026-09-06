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
  applyBalanceDelta,
  insertFeeClaim,
  insertFeeEvent,
  insertLaunch,
  insertSwap,
  insertTransfer,
  readBlockHash,
  readCursor,
  rebuildCandle,
  rollbackFrom,
  setSwapFee,
  upsertBlock,
  writeCursor,
  type Db,
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
      const rollbackTo = ancestor + 1n;
      log('reorg detected', { lastNumber: lastNumber.toString(), rollbackTo: rollbackTo.toString() });
      await rollbackFrom(db, rollbackTo);
      const ancestorHash = ancestor >= deployment.deployBlock ? (await chain.getBlock(ancestor)).hash : null;
      await writeCursor(db, rollbackTo, ancestorHash);
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
  for (const number of blockNumbers) blocks.set(number, await chain.getBlock(number));
  const blockTime = (number: bigint) => new Date(Number(blocks.get(number)!.timestamp) * 1000);

  // 4. Transaction senders for swaps.
  const senders = new Map<Hex, Address | null>();
  for (const l of swapLogs) {
    if (l.transactionHash && !senders.has(l.transactionHash)) {
      senders.set(l.transactionHash, await chain.getTransactionSender(l.transactionHash));
    }
  }

  let launches = 0;
  let swaps = 0;
  let transfers = 0;
  await db.transaction(async (tx) => {
    for (const block of blocks.values()) {
      await upsertBlock(tx, {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: new Date(Number(block.timestamp) * 1000),
      });
    }

    for (const { log: raw, event } of launchedLogs) {
      const pool = pools.get(event.poolId.toLowerCase());
      if (!pool || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
      await insertLaunch(tx, {
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
      launches += 1;
    }

    const touchedCandles = new Set<string>();
    for (const raw of swapLogs) {
      const swap = decodeSwap(raw);
      if (!swap || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
      const pool = pools.get(swap.poolId.toLowerCase());
      if (!pool) continue;
      const { side, amountTokenRaw, amountStockRaw } = classifySwap(swap, pool.tokenIsCurrency0);
      const priceE30 = stockPerTokenE30(swap.sqrtPriceX96, pool.tokenIsCurrency0, pool.stockDecimals);
      const time = blockTime(raw.blockNumber);
      await insertSwap(tx, {
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
      touchedCandles.add(`${pool.token.toLowerCase()}|${minuteBucket(time).toISOString()}`);
      swaps += 1;
    }

    for (const raw of contractLogs) {
      if (raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
      const fee = decodeFeeCharged(raw);
      if (fee) {
        const pool = pools.get(fee.poolId.toLowerCase());
        if (!pool) continue;
        await insertFeeEvent(tx, {
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
        await setSwapFee(tx, raw.transactionHash, fee.poolId, fee.amount);
        continue;
      }
      const claim = decodeFeesClaimed(raw);
      if (claim) {
        await insertFeeClaim(tx, {
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

    for (const raw of transferLogs) {
      const transfer = decodeTransfer(raw);
      if (!transfer || raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) continue;
      const inserted = await insertTransfer(tx, {
        txHash: raw.transactionHash,
        logIndex: raw.logIndex,
        token: raw.address,
        from: transfer.from,
        to: transfer.to,
        amountRaw: transfer.value,
        blockNumber: raw.blockNumber,
        blockTime: blockTime(raw.blockNumber),
      });
      if (!inserted || transfer.value === 0n) continue;
      if (transfer.from.toLowerCase() !== ZERO_ADDRESS) {
        await applyBalanceDelta(tx, raw.address, transfer.from, -transfer.value, raw.blockNumber);
      }
      if (transfer.to.toLowerCase() !== ZERO_ADDRESS) {
        await applyBalanceDelta(tx, raw.address, transfer.to, transfer.value, raw.blockNumber);
      }
      transfers += 1;
    }

    for (const key of touchedCandles) {
      const [token, bucket] = key.split('|') as [string, string];
      await rebuildCandle(tx, token, new Date(bucket));
    }

    await writeCursor(tx, to + 1n, blocks.get(to)!.hash);
  });

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
): Promise<bigint> {
  for (let number = from; number >= floor && from - number <= BigInt(maxDepth); number -= 1n) {
    const stored = await readBlockHash(db, number);
    if (stored === null) continue;
    const onchain = await chain.getBlock(number);
    if (onchain.hash.toLowerCase() === stored.toLowerCase()) return number;
  }
  return floor - 1n;
}

export function minuteBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}
