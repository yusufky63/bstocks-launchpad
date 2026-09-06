import type { Address } from 'viem';

import { listStocks, setStockEnabled, upsertStockQuote, type Db } from '@stockpair/core/db';

import type { ChainReader } from './chain-reader';

/**
 * Mirrors the factory's enabled flag for every stock (the owner disables stocks Coinbase has not
 * issued on Base), then reads each enabled stock's Chainlink feed and stores the latest observation.
 */
export async function refreshStockQuotes(
  db: Db,
  chain: ChainReader,
  factory: Address,
  now: () => Date = () => new Date(),
): Promise<number> {
  const stocks = await listStocks(db);
  const block = await chain.getBlockNumber();
  let updated = 0;
  for (const stock of stocks) {
    const enabled = await chain.readStockEnabled(factory, stock.address as Address);
    if (enabled !== null && enabled !== stock.enabled) {
      await setStockEnabled(db, stock.address, enabled);
      stock.enabled = enabled;
    }
    if (!stock.enabled) continue;
    const reading = await chain.readFeed(stock.feed as Address);
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
