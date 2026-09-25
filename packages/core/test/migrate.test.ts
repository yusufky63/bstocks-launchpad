import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createEmbeddedDb } from '../src/db/client';
import { SCHEMA_VERSION, migrate } from '../src/db/migrate';
import { BASE_STOCKS } from '../src/stocks';

const BASE_STOCK = BASE_STOCKS[0]!.address.toLowerCase();

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
  'metadata_updates_token_idx',
  'metadata_updates_block_idx',
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

  // Production is at version 7 with real launches in it. Upgrading must leave every one of them
  // reading as what it is: a fixed profile, no onchain change, deployment still to be backfilled.
  it('upgrades a version 7 database and old rows read as fixed profiles', async () => {
    const db = await createEmbeddedDb();
    const schema = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    const marker = schema.indexOf('-- Version 8');
    expect(marker).toBeGreaterThan(0);
    await db.exec(schema.slice(0, marker));
    await db.exec("INSERT INTO schema_version (version) VALUES (7)");
    await db.exec(`INSERT INTO stocks (address, symbol, name, ticker, decimals, feed) VALUES ('0xs', 'S', 'S', 'S', 8, '0xf')`);
    await db.exec(`INSERT INTO launches (token, stock, creator, pool_id, token_is_currency0, name, symbol, contract_uri,
      opening_sqrt_price_x96, tick_lower, tick_upper, liquidity, stock_usd8_at_launch, block_number, block_hash, tx_hash,
      log_index, launched_at, metadata_fetched_at)
      VALUES ('0xold', '0xs', '0xc', '0xp', false, 'Old', 'OLD', 'https://example.test/old.json', 1, -887200, 100, 1, 1, 1, '0xb',
        '0xt', 0, now(), now())`);

    await migrate(db);

    const [row] = await db.query<Record<string, unknown>>(
      `SELECT metadata_editable, metadata_locked_at, current_contract_uri, telegram, factory, hook, contract_uri,
              metadata_fetched_at FROM launches WHERE token = '0xold'`,
    );
    expect(row).toMatchObject({
      metadata_editable: false,
      metadata_locked_at: null,
      current_contract_uri: null,
      telegram: null,
      factory: null,
      hook: null,
      contract_uri: 'https://example.test/old.json',
    });
    // Nothing about the upgrade asks for the old profile to be fetched again.
    expect(row!.metadata_fetched_at).not.toBeNull();
    const version = await db.query<{ version: string }>('SELECT max(version)::text AS version FROM schema_version');
    expect(Number(version[0]!.version)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(8);
    const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    expect(tables.map((t) => t.tablename)).toEqual(expect.arrayContaining(['metadata_updates', 'indexed_deployments']));
    await db.close();
  });

  // A rollback, or code that is simply older than the database: a newer release has migrated it and
  // owns it now. Re-running this release's schema or stock list could only take something away.
  it('leaves a database migrated by a newer release exactly as it is', async () => {
    const db = await createEmbeddedDb();
    await migrate(db);
    await db.exec('INSERT INTO schema_version (version) VALUES (' + String(SCHEMA_VERSION + 1) + ')');
    await db.exec('DROP INDEX swaps_token_block_idx');
    await db.exec("UPDATE stocks SET name = 'renamed by a newer release' WHERE symbol = 'NVDAc'");
    const logged: string[] = [];

    await migrate(db, (message) => logged.push(message));

    expect(await indexNames(db)).not.toContain('swaps_token_block_idx');
    const [stock] = await db.query<{ name: string }>("SELECT name FROM stocks WHERE symbol = 'NVDAc'");
    expect(stock?.name).toBe('renamed by a newer release');
    const version = await db.query<{ version: string }>('SELECT max(version)::text AS version FROM schema_version');
    expect(Number(version[0]!.version)).toBe(SCHEMA_VERSION + 1);
    expect(logged).toEqual(['schema is newer than this code; leaving it as it is']);
    await db.close();
  });

  // Release order: version 8 goes onto production before the new web and alerts, while the release
  // deployed today (schema 7) is still running against it. These are its statements, verbatim.
  it('keeps the schema 7 release working on a version 8 database', async () => {
    const db = await createEmbeddedDb();
    await migrate(db);
    const schema = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

    // Its migrate() sees 8 !== 7 and re-applies its own schema file, then records 7.
    await db.exec(schema.slice(0, schema.indexOf('-- Version 8')));
    await db.exec('INSERT INTO schema_version (version) VALUES (7) ON CONFLICT (version) DO NOTHING');
    const version = await db.query<{ version: string }>('SELECT max(version)::text AS version FROM schema_version');
    expect(Number(version[0]!.version)).toBe(SCHEMA_VERSION);

    // Its launch insert names eighteen columns; every column version 8 added is nullable or defaulted.
    await db.query(
      `INSERT INTO launches (token, stock, creator, pool_id, token_is_currency0, name, symbol,
         contract_uri, opening_sqrt_price_x96, tick_lower, tick_upper, liquidity,
         stock_usd8_at_launch, block_number, block_hash, tx_hash, log_index, launched_at)
       VALUES ($1, $2, '0xc', '0xp', false, 'Old', 'OLD', 'ipfs://old', 1, -887200, 100, 1, 1, 100, '0xb', '0xt', 0, now())
       ON CONFLICT (token) DO NOTHING`,
      ['0xold', BASE_STOCK],
    );
    const [row] = await db.query<Record<string, unknown>>('SELECT metadata_editable, factory, hook FROM launches');
    expect(row).toEqual({ metadata_editable: false, factory: null, hook: null });

    // Its reorg rollback deletes launches without knowing metadata_updates exists. A row the new
    // release wrote for that launch must not block the delete.
    await db.exec(`INSERT INTO metadata_updates (tx_hash, log_index, token, kind, contract_uri, block_number, block_time)
      VALUES ('0xu', 0, '0xold', 'uri', 'ipfs://new', 101, now())`);
    await db.query('DELETE FROM launches WHERE block_number >= $1', ['100']);
    expect(await db.query('SELECT 1 FROM launches')).toHaveLength(0);
    expect(await db.query('SELECT 1 FROM metadata_updates')).toHaveLength(0);
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
