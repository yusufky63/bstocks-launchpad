import type { Address } from 'viem';

import { listStocks, setStockEnabled, upsertStockQuote, type Db } from '@stockpair/core/db';

import type { ChainReader } from './chain-reader';

/**
 * Mirrors each stock's enabled flag from `factory`, the newest deployment's (the owner disables
 * stocks Coinbase has not issued on Base), then reads the Chainlink feed of every stock that is
 * enabled there or already has a launch, and stores the latest observation.
 *
 * `enabled` only says what the create form may offer. Tokens launched on an older factory keep
 * trading after a stock is disabled on it, so their stock's price has to keep moving too.
 */
export async function refreshStockQuotes(
  db: Db,
  chain: ChainReader,
  factory: Address,
  now: () => Date = () => new Date(),
): Promise<number> {
  const stocks = await listStocks(db);
  const launched = new Set(
    (await db.query<{ stock: string }>('SELECT DISTINCT stock FROM launches')).map((row) => row.stock.toLowerCase()),
  );
  // Every chain read goes out at once: the reader folds reads issued together into one request,
  // so thirteen stocks cost one call a minute instead of twenty-six. The feeds of stocks that end up
  // skipped are read too; asking for them costs nothing extra in the same request.
  const [block, enabledFlags, readings] = await Promise.all([
    chain.getBlockNumber(),
    Promise.all(stocks.map((stock) => chain.readStockEnabled(factory, stock.address as Address))),
    Promise.all(stocks.map((stock) => chain.readFeed(stock.feed as Address))),
  ]);
  let updated = 0;
  for (const [i, stock] of stocks.entries()) {
    const enabled = enabledFlags[i] ?? null;
    if (enabled !== null && enabled !== stock.enabled) {
      await setStockEnabled(db, stock.address, enabled);
      stock.enabled = enabled;
    }
    if (!stock.enabled && !launched.has(stock.address.toLowerCase())) continue;
    const reading = readings[i] ?? null;
    if (!reading || reading.answer <= 0n) continue;
    await upsertStockQuote(db, {
      stock: stock.address,
      priceUsd8: reading.answer,
      feedUpdatedAt: new Date(Number(reading.updatedAt) * 1000),
      observedAt: now(),
      observedBlock: block,
    });
    updated += 1;
  }
  return updated;
}
