import { describe, expect, it } from 'vitest';

import { createEmbeddedDb } from '../src/db/client';
import { SCHEMA_VERSION, migrate } from '../src/db/migrate';

const INDEXES = [
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
  'alert_outbox_pending_idx',
  'alert_outbox_block_idx',
  'alert_outbox_dedupe_idx',
];

async function indexNames(db: Awaited<ReturnType<typeof createEmbeddedDb>>): Promise<Set<string>> {
  const rows = await db.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  return new Set(rows.map((r) => r.indexname));
}

describe('migrate', () => {
  // The schema is applied in two passes (tables, then indexes one by one so a blocked index cannot
  // stop a process from starting). This guards the split: every index must still be created.
  it('creates every index declared in the schema and records the version', async () => {
    const db = await createEmbeddedDb();
    await migrate(db);

    const created = await indexNames(db);
    for (const name of INDEXES) expect(created, `missing index ${name}`).toContain(name);

    const version = await db.query<{ version: string }>('SELECT max(version)::text AS version FROM schema_version');
    expect(Number(version[0]!.version)).toBe(SCHEMA_VERSION);

    const stocks = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM stocks');
    expect(Number(stocks[0]!.n)).toBe(13);
    await db.close();
  });

  it('runs no DDL once the database is already at the current version', async () => {
    const db = await createEmbeddedDb();
    await migrate(db);
    // If the second run re-issued the schema it would recreate this; the fast path must skip it.
    await db.exec('DROP INDEX swaps_token_block_idx');
    await migrate(db);
    expect(await indexNames(db)).not.toContain('swaps_token_block_idx');
    await db.close();
  });

  it('skips an index it cannot build, and retries it on the next start', async () => {
    const db = await createEmbeddedDb();
    const warnings: string[] = [];
    // Renaming a column makes exactly one index statement fail; the rest must still apply.
    await db.exec('CREATE TABLE schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await db.exec('CREATE TABLE swaps (token text, block_number bigint, block_time timestamptz, trader text, log_index integer)');
    await db.exec('ALTER TABLE swaps RENAME COLUMN log_index TO log_index_renamed');

    await expect(migrate(db, (m) => warnings.push(m))).resolves.toBeUndefined();
    expect(warnings).toContain('index skipped');
    // The version stays unrecorded so the missing index is attempted again next time.
    const version = await db.query<{ version: string | null }>('SELECT max(version)::text AS version FROM schema_version');
    expect(version[0]!.version).toBeNull();
    await db.close();
  });
});
