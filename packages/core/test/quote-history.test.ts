import { beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { listStockQuoteHistory, upsertStockQuote } from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const at = (iso: string) => new Date(iso);

let db: Db;

describe('listStockQuoteHistory', () => {
  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    for (const [iso, usd] of [
      ['2026-09-01T10:00:00Z', 200],
      ['2026-09-02T10:00:00Z', 210],
      ['2026-09-03T10:00:00Z', 220],
      ['2026-09-04T10:00:00Z', 230],
    ] as const) {
      await upsertStockQuote(db, {
        stock: NVDAc,
        priceUsd8: BigInt(usd * 1e8),
        feedUpdatedAt: at(iso),
        observedAt: at(iso),
        observedBlock: 1n,
      });
    }
  });

  it('includes the quote still in effect when the window opens', async () => {
    // The window starts after the 02 quote, so that one must come along or the first candle in the
    // window would have no price to use.
    const rows = await listStockQuoteHistory(db, NVDAc, at('2026-09-02T18:00:00Z'), at('2026-09-03T18:00:00Z'));
    const prices = rows.map((r) => Number(r.price_usd8) / 1e8);
    expect(prices).toEqual([210, 220]);
  });

  it('stops at the end of the window and stays in order', async () => {
    const rows = await listStockQuoteHistory(db, NVDAc, at('2026-09-01T00:00:00Z'), at('2026-09-03T12:00:00Z'));
    expect(rows.map((r) => Number(r.price_usd8) / 1e8)).toEqual([200, 210, 220]);
    expect(rows.map((r) => r.feed_updated_at.getTime())).toEqual([...rows.map((r) => r.feed_updated_at.getTime())].sort((a, b) => a - b));
  });

  it('returns nothing when the window predates every quote', async () => {
    const rows = await listStockQuoteHistory(db, NVDAc, at('2026-08-01T00:00:00Z'), at('2026-08-02T00:00:00Z'));
    expect(rows).toHaveLength(0);
  });
});
