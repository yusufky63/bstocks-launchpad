import { describe, expect, it } from 'vitest';

import { createEmbeddedDb } from '../src/db/client';
import { migrate } from '../src/db/migrate';

describe('migrate', () => {
  // The schema is applied in two passes (tables, then indexes one by one so a blocked index cannot
  // stop a process from starting). This guards the split: every index must still be created.
  it('creates every index declared in the schema, and is idempotent', async () => {
    const db = await createEmbeddedDb();
    await migrate(db);
    await migrate(db);

    const rows = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const created = new Set(rows.map((r) => r.indexname));
    for (const name of [
      'launches_stock_idx',
      'launches_creator_idx',
      'launches_time_idx',
      'swaps_token_time_idx',
      'swaps_token_block_idx',
      'swaps_trader_idx',
      'swaps_block_idx',
      'transfers_token_idx',
      'balances_rank_idx',
      'balances_holder_idx',
      'fee_events_token_idx',
      'fee_claims_account_idx',
    ]) {
      expect(created, `missing index ${name}`).toContain(name);
    }

    const stocks = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM stocks');
    expect(Number(stocks[0]!.n)).toBe(13);
    await db.close();
  });

  it('reports an index it could not build instead of throwing', async () => {
    const db = await createEmbeddedDb();
    const warnings: string[] = [];
    // Dropping the table an index targets makes that one statement fail; migrate must carry on.
    await migrate(db);
    await db.exec('DROP INDEX swaps_token_block_idx');
    await db.exec('ALTER TABLE swaps RENAME COLUMN log_index TO log_index_renamed');
    await expect(migrate(db, (m) => warnings.push(m))).resolves.toBeUndefined();
    expect(warnings).toContain('index skipped');
    await db.close();
  });
});
