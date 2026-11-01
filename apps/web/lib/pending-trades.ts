import { BASE_CONTRACTS, classifySwap, decodeFeeCharged, decodeSwap, e30ToDecimalString, stockPerTokenE30, SUPPLY_WHOLE, type RawLog } from '@stockpair/core';

import { createPendingStore, pendingKey as key, type Pending } from './pending-store';
import type { CandleView, MarketView, SwapView } from './types';

export { GIVE_UP_MS, KEEP_AFTER_INDEXED_MS } from './pending-store';

/**
 * The connected wallet's own trades, read from their receipt the moment the wallet reports them
 * mined, and shown until the indexer has stored them.
 *
 * The indexer records a block only once it is a few confirmations deep and the database is a long
 * round trip away from it, so a trade reaches the API several seconds after its receipt. Until then
 * the trader would watch "Confirmed" next to a chart, a price and a trades list that did not move.
 * Everything here comes from the receipt's own logs, decoded the way the indexer decodes them, so
 * the row that replaces it carries the same numbers. Nothing is estimated, and only trades this
 * browser sent are ever shown this way.
 */
export type PendingTrade = Pending<
  SwapView & {
    /** The stock's USD quote used to price the row, so a candle can carry it like an indexed one. */
    stockUsd: number | null;
  }
>;

export type TradeReceipt = { from: string; blockNumber: bigint; logs: readonly RawLog[] };

export type PendingMarket = {
  token: string;
  poolId: string;
  creator: string;
  hook: string | null;
  stock: { address: string; decimals: number };
  stockUsd: number | null;
};

const order = (a: SwapView, b: SwapView) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || a.logIndex - b.logIndex;

/**
 * This pool's swaps in a mined receipt, as the trades API would list them. Fees pair with swaps the
 * way the indexer pairs them: within one transaction and pool, the nth FeeCharged belongs to the
 * nth Swap. The trader is the transaction's sender, again as the indexer records it.
 */
export function tradesFromReceipt(receipt: TradeReceipt, market: PendingMarket, blockTime: Date): SwapView[] {
  const poolId = market.poolId.toLowerCase();
  const tokenIsCurrency0 = market.token.toLowerCase() < market.stock.address.toLowerCase();
  const stockUnit = 10 ** market.stock.decimals;
  const fees: bigint[] = [];
  const swaps: { log: RawLog; swap: NonNullable<ReturnType<typeof decodeSwap>> }[] = [];
  for (const log of receipt.logs) {
    const address = log.address.toLowerCase();
    if (address === BASE_CONTRACTS.poolManager.toLowerCase()) {
      const swap = decodeSwap(log);
      if (swap && swap.poolId.toLowerCase() === poolId) swaps.push({ log, swap });
    } else if (market.hook && address === market.hook.toLowerCase()) {
      const fee = decodeFeeCharged(log);
      if (fee && fee.poolId.toLowerCase() === poolId) fees.push(fee.amount);
    }
  }
  const trader = receipt.from.toLowerCase();
  return swaps.flatMap(({ log, swap }, i) => {
    if (log.transactionHash === null || log.logIndex === null) return [];
    const { side, amountTokenRaw, amountStockRaw } = classifySwap(swap, tokenIsCurrency0);
    const price = Number(e30ToDecimalString(stockPerTokenE30(swap.sqrtPriceX96, tokenIsCurrency0, market.stock.decimals)));
    const amountStock = Number(amountStockRaw) / stockUnit;
    return [
      {
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        side,
        trader,
        sender: swap.sender.toLowerCase(),
        amountToken: Number(amountTokenRaw) / 1e18,
        amountStock,
        feeStock: Number(fees[i] ?? 0n) / stockUnit,
        amountUsd: market.stockUsd === null ? null : amountStock * market.stockUsd,
        price,
        priceUsd: market.stockUsd === null ? null : price * market.stockUsd,
        blockNumber: receipt.blockNumber.toString(),
        blockTime: blockTime.toISOString(),
        isCreator: trader === market.creator.toLowerCase(),
      },
    ];
  });
}

/** Rows the indexed list does not hold yet, newest first and marked pending, ahead of it. */
export function withPendingSwaps(indexed: readonly SwapView[], pending: readonly PendingTrade[]): SwapView[] {
  if (pending.length === 0) return indexed as SwapView[];
  const seen = new Set(indexed.map(key));
  const extra = pending
    .filter((p) => !seen.has(key(p)))
    .sort((a, b) => order(b, a))
    .map((p): SwapView => ({ ...p, pending: true }));
  return extra.length === 0 ? (indexed as SwapView[]) : [...extra, ...indexed];
}

/**
 * Candles with the pending trades folded in, at the chart's bucket width. Candles fetched after the
 * trades list first held a trade already contain it; older ones do not, whatever the list says now.
 * A trade opens a new bucket at its own price, which is how the indexer opens one.
 */
export function withPendingCandles(candles: readonly CandleView[], pending: readonly PendingTrade[], bucketMinutes: number, fetchedAt: number): CandleView[] {
  const apply = pending.filter((p) => p.indexedAt === null || fetchedAt < p.indexedAt).sort(order);
  if (apply.length === 0) return candles as CandleView[];
  const size = bucketMinutes * 60;
  const out = candles.slice();
  for (const p of apply) {
    const time = Math.floor(Date.parse(p.blockTime) / 1000 / size) * size;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      out[out.length - 1] = {
        ...last,
        high: Math.max(last.high, p.price),
        low: Math.min(last.low, p.price),
        close: p.price,
        volumeStock: last.volumeStock + p.amountStock,
        volumeToken: last.volumeToken + p.amountToken,
        trades: last.trades + 1,
      };
    } else if (!last || time > last.time) {
      out.push({ time, open: p.price, high: p.price, low: p.price, close: p.price, volumeStock: p.amountStock, volumeToken: p.amountToken, trades: 1, stockUsd: p.stockUsd });
    }
  }
  return out;
}

type PricedMarket = Pick<MarketView, 'priceInStock' | 'priceUsd' | 'fdvUsd' | 'lastTradeAt' | 'stockUsd'>;

/** The market priced at the newest pending trade, when that trade is newer than the market's last one. */
export function withPendingPrice<M extends PricedMarket>(market: M, pending: readonly PendingTrade[]): M {
  const latest = pending.slice().sort(order).at(-1);
  if (!latest) return market;
  if (market.lastTradeAt !== null && Date.parse(latest.blockTime) <= Date.parse(market.lastTradeAt)) return market;
  const priceUsd = market.stockUsd === null ? null : latest.price * market.stockUsd;
  return { ...market, priceInStock: latest.price, priceUsd, fdvUsd: priceUsd === null ? null : priceUsd * Number(SUPPLY_WHOLE), lastTradeAt: latest.blockTime };
}

// ---------------------------------------------------------------------------------------------
// Store. Per page load, in memory: a reload drops it and the indexed data is all there is.
// ---------------------------------------------------------------------------------------------

const store = createPendingStore<SwapView & { stockUsd: number | null }>();

export function addPendingTrades(token: string, trades: readonly SwapView[], stockUsd: number | null, now = Date.now()): void {
  store.add(token, trades.map((t) => ({ ...t, stockUsd })), now);
}

/** Notes which pending trades the indexed list now holds, and drops the ones that are done. */
export function markIndexed(token: string, indexed: readonly SwapView[], now = Date.now()): void {
  store.markIndexed(token, indexed, now);
}

export function pendingTrades(token: string): readonly PendingTrade[] {
  return store.list(token);
}

export function usePendingTrades(token: string): readonly PendingTrade[] {
  return store.use(token);
}
