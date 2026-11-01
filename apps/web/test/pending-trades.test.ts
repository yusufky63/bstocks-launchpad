import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { BASE_CONTRACTS, BASE_STOCKS, e30ToDecimalString, stockPairHookAbi, stockPerTokenE30, UNISWAP_V4_SWAP_TOPIC, type RawLog } from '@stockpair/core';

import {
  addPendingTrades,
  GIVE_UP_MS,
  KEEP_AFTER_INDEXED_MS,
  markIndexed,
  pendingTrades,
  tradesFromReceipt,
  withPendingCandles,
  withPendingPrice,
  withPendingSwaps,
  type PendingMarket,
  type PendingTrade,
} from '@/lib/pending-trades';
import type { CandleView, SwapView } from '@/lib/types';

const STOCK = BASE_STOCKS[0]!.address as Address;
const TOKEN = '0xb2000000000000000000000000000000000000aa' as Address; // sorts before the stock: currency0
const HOOK = '0x00000000000000000000000000000000000000c4' as Address;
const ROUTER = '0x00000000000000000000000000000000000000e0' as Address;
const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const TRADER = '0x2222222222222222222222222222222222222222' as Address;
const POOL_ID = `0x${'cd'.repeat(32)}` as Hex;
const OTHER_POOL = `0x${'ab'.repeat(32)}` as Hex;
const TX = `0x${'ee'.repeat(32)}` as Hex;
const SQRT = 117_000_000_000_000_000_000n;

const market: PendingMarket = { token: TOKEN, poolId: POOL_ID, creator: CREATOR, hook: HOOK, stock: { address: STOCK, decimals: 8 }, stockUsd: 180 };

function swapLog(amount0: bigint, amount1: bigint, logIndex: number, poolId: Hex = POOL_ID): RawLog {
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [amount0, amount1, SQRT, 10n ** 20n, 5, 0],
  );
  return { address: BASE_CONTRACTS.poolManager, topics: [UNISWAP_V4_SWAP_TOPIC, poolId, `0x000000000000000000000000${ROUTER.slice(2)}`], data, blockNumber: 77n, transactionHash: TX, logIndex };
}

function feeLog(amount: bigint, logIndex: number): RawLog {
  const args = { poolId: POOL_ID, stock: STOCK, amount, creatorAmount: (amount * 7n) / 10n, platformAmount: amount - (amount * 7n) / 10n, feeBps: 100n };
  const event = stockPairHookAbi.find((item) => item.type === 'event' && item.name === 'FeeCharged') as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const unindexed = event.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: stockPairHookAbi, eventName: 'FeeCharged', args } as never) as unknown as [Hex, ...Hex[]];
  const data = encodeAbiParameters(unindexed, unindexed.map((i) => args[i.name as keyof typeof args]) as never);
  return { address: HOOK, topics, data, blockNumber: 77n, transactionHash: TX, logIndex };
}

const AT = new Date('2026-10-04T10:00:30Z');

function row(over: Partial<SwapView> = {}): SwapView {
  return {
    txHash: TX,
    logIndex: 1,
    side: 'buy',
    trader: TRADER,
    sender: ROUTER,
    amountToken: 1_000_000,
    amountStock: 0.99,
    feeStock: 0.01,
    amountUsd: 178.2,
    price: 0.000001,
    priceUsd: 0.00018,
    blockNumber: '77',
    blockTime: AT.toISOString(),
    isCreator: false,
    ...over,
  };
}

function pending(over: Partial<PendingTrade> = {}): PendingTrade {
  return { ...row(), token: TOKEN.toLowerCase(), stockUsd: 180, recordedAt: 0, indexedAt: null, ...over };
}

describe('tradesFromReceipt', () => {
  it('reads this pool\'s swap and its fee from the receipt the way the indexer does', () => {
    const receipt = {
      from: TRADER,
      blockNumber: 77n,
      // A swap on another pool and a log from an unrelated contract in the same transaction are not this trade.
      logs: [feeLog(1_000_000n, 0), swapLog(10n ** 24n, -99_000_000n, 1), swapLog(5n, -5n, 2, OTHER_POOL), { ...feeLog(9n, 3), address: ROUTER }],
    };
    const [trade, ...rest] = tradesFromReceipt(receipt, market, AT);
    expect(rest).toHaveLength(0);
    const price = Number(e30ToDecimalString(stockPerTokenE30(SQRT, true, 8)));
    expect(trade).toEqual({
      txHash: TX,
      logIndex: 1,
      side: 'buy',
      trader: TRADER.toLowerCase(),
      sender: ROUTER.toLowerCase(),
      amountToken: 1_000_000,
      amountStock: 0.99,
      feeStock: 0.01,
      amountUsd: 0.99 * 180,
      price,
      priceUsd: price * 180,
      blockNumber: '77',
      blockTime: AT.toISOString(),
      isCreator: false,
    });
  });

  it('marks the creator\'s own trade and reads a sell, with no USD when the stock has no quote', () => {
    const receipt = { from: CREATOR, blockNumber: 78n, logs: [swapLog(-(10n ** 24n), 50_000_000n, 4)] };
    const [trade] = tradesFromReceipt(receipt, { ...market, stockUsd: null }, AT);
    expect(trade).toMatchObject({ side: 'sell', isCreator: true, amountStock: 0.5, feeStock: 0, amountUsd: null, priceUsd: null, blockNumber: '78' });
  });
});

describe('withPendingSwaps', () => {
  it('puts the trades the indexed list lacks on top, newest first and marked', () => {
    const indexed = [row({ txHash: `0x${'01'.repeat(32)}`, blockNumber: '70' })];
    const out = withPendingSwaps(indexed, [pending({ blockNumber: '77' }), pending({ blockNumber: '79', logIndex: 3 })]);
    expect(out.map((s) => [s.blockNumber, s.pending ?? false])).toEqual([
      ['79', true],
      ['77', true],
      ['70', false],
    ]);
  });

  it('shows the indexed row, not the pending one, once the list holds the trade', () => {
    const indexed = [row({ txHash: TX.toUpperCase().replace('0X', '0x') as Hex })];
    expect(withPendingSwaps(indexed, [pending()])).toBe(indexed);
  });
});

describe('withPendingCandles', () => {
  const minute = Math.floor(AT.getTime() / 60_000) * 60;
  const candle = (time: number, close: number): CandleView => ({ time, open: 1, high: Math.max(1, close), low: Math.min(1, close), close, volumeStock: 2, volumeToken: 3, trades: 4, stockUsd: 170 });

  it('moves the bar the trade falls in', () => {
    const [bar] = withPendingCandles([candle(minute, 1)], [pending({ price: 3 })], 1, 0);
    expect(bar).toEqual({ time: minute, open: 1, high: 3, low: 1, close: 3, volumeStock: 2.99, volumeToken: 1_000_003, trades: 5, stockUsd: 170 });
  });

  it('opens a new bar at the trade\'s own price, at the chart\'s width, the way the indexer would', () => {
    const fiveMin = Math.floor(AT.getTime() / 300_000) * 300;
    const out = withPendingCandles([candle(fiveMin - 300, 1)], [pending({ price: 2 })], 5, 0);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ time: fiveMin, open: 2, high: 2, low: 2, close: 2, volumeStock: 0.99, volumeToken: 1_000_000, trades: 1, stockUsd: 180 });
    // The first trade of a token draws the first bar.
    expect(withPendingCandles([], [pending({ price: 2 })], 1, 0)).toHaveLength(1);
  });

  it('leaves candles alone once they were fetched after the list held the trade', () => {
    const candles = [candle(minute, 1)];
    expect(withPendingCandles(candles, [pending({ indexedAt: 5_000 })], 1, 6_000)).toBe(candles);
    expect(withPendingCandles(candles, [pending({ indexedAt: 5_000, price: 3 })], 1, 4_000)[0]?.close).toBe(3);
  });
});

describe('withPendingPrice', () => {
  const base = { priceInStock: 0.5, priceUsd: 90, fdvUsd: 90e9, lastTradeAt: '2026-10-04T10:00:00.000Z', stockUsd: 180 };

  it('prices the market at a trade newer than its last one', () => {
    expect(withPendingPrice(base, [pending({ price: 0.6 })])).toEqual({ priceInStock: 0.6, priceUsd: 108, fdvUsd: 108e9, lastTradeAt: AT.toISOString(), stockUsd: 180 });
  });

  it('keeps the market once it has caught up, and with nothing pending', () => {
    const caughtUp = { ...base, lastTradeAt: AT.toISOString() };
    expect(withPendingPrice(caughtUp, [pending({ price: 0.6 })])).toBe(caughtUp);
    expect(withPendingPrice(base, [])).toBe(base);
  });
});

describe('the pending store', () => {
  const token = '0xb2000000000000000000000000000000000000f1';

  it('keeps a trade until the list has held it for a while, and gives up on one it never gets', () => {
    addPendingTrades(token, [row({ logIndex: 1 }), row({ logIndex: 2 })], 180, 1_000);
    // Recording the same receipt twice does not double it.
    addPendingTrades(token.toUpperCase().replace('0X', '0x'), [row({ logIndex: 1 })], 180, 1_500);
    expect(pendingTrades(token).map((p) => p.logIndex)).toEqual([1, 2]);

    markIndexed(token, [row({ logIndex: 1 })], 2_000);
    expect(pendingTrades(token).map((p) => [p.logIndex, p.indexedAt])).toEqual([
      [1, 2_000],
      [2, null],
    ]);
    // Nothing new: the same snapshot, so subscribers do not re-render.
    const before = pendingTrades(token);
    markIndexed(token, [row({ logIndex: 1 })], 2_500);
    expect(pendingTrades(token)).toBe(before);

    markIndexed(token, [], 2_000 + KEEP_AFTER_INDEXED_MS);
    expect(pendingTrades(token).map((p) => p.logIndex)).toEqual([2]);
    markIndexed(token, [], 1_000 + GIVE_UP_MS);
    expect(pendingTrades(token)).toHaveLength(0);
  });
});
