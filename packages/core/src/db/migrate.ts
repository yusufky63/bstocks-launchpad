import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './client';
import { BASE_STOCKS } from '../stocks';

/** Bump whenever schema.sql changes, so running processes re-apply it once and then stop. */
export const SCHEMA_VERSION = 5;

async function schemaSql(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, 'schema.sql'), 'utf8');
}

/**
 * Splits the one-line `CREATE INDEX` statements out of the schema. Tables and constraints are
 * essential and must apply; indexes are optimisations that are applied separately so a slow or
 * lock-blocked index can never stop the process from starting.
 */
function splitIndexes(sql: string): { core: string; indexes: string[] } {
  const core: string[] = [];
  const indexes: string[] = [];
  for (const line of sql.split(/\r?\n/u)) {
    const isIndex = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(line) && line.trimEnd().endsWith(';');
    (isIndex ? indexes : core).push(isIndex ? line.trim() : line);
  }
  return { core: core.join('\n'), indexes };
}

type Log = (message: string, fields?: Record<string, unknown>) => void;

/** The schema version already applied, or null when the database is empty or unreadable. */
async function appliedVersion(db: Db): Promise<number | null> {
  try {
    const rows = await db.query<{ version: string }>(
      'SELECT max(version)::text AS version FROM schema_version',
    );
    const value = rows[0]?.version;
    return value == null ? null : Number(value);
  } catch {
    return null; // table does not exist yet
  }
}

/**
 * Applies the schema and seeds the stock registry.
 *
 * A database already at SCHEMA_VERSION runs no DDL at all: a restarting process should not re-issue
 * CREATE statements against a live database every time it boots, because each one takes catalog
 * locks and any of them can be held up long enough to hit the server's statement timeout.
 *
 * When the schema does need applying, tables and constraints go first and still throw if they fail —
 * nothing works without them. Indexes are applied one at a time and a failure is logged and skipped:
 * a missing index costs a sort, whereas throwing here crash-loops the indexer and stops it following
 * the chain. The version is only recorded once every index is in place, so a skipped one is retried
 * on the next start instead of being silently lost.
 */
export async function migrate(db: Db, log: Log = () => undefined): Promise<void> {
  if ((await appliedVersion(db)) !== SCHEMA_VERSION) {
    const { core, indexes } = splitIndexes(await schemaSql());
    await db.exec(core);
    let complete = true;
    for (const statement of indexes) {
      try {
        // The timeout rides in the same simple-query batch so it lands on this statement's connection.
        await db.exec(`SET statement_timeout = '120s';\n${statement}`);
      } catch (error) {
        complete = false;
        log('index skipped', { statement, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (complete) {
      await db.query(
        'INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [SCHEMA_VERSION],
      );
    }
  }
  for (const stock of BASE_STOCKS) {
    await db.query(
      `INSERT INTO stocks (address, symbol, name, ticker, decimals, feed, enabled, image_uri)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       ON CONFLICT (address) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name,
         ticker = EXCLUDED.ticker, decimals = EXCLUDED.decimals, feed = EXCLUDED.feed,
         image_uri = EXCLUDED.image_uri`,
      [
        stock.address.toLowerCase(),
        stock.symbol,
        stock.name,
        stock.ticker,
        stock.decimals,
        stock.feed.toLowerCase(),
        stock.image,
      ],
    );
  }
}

/** Drops everything in the public schema (and the legacy private schema) and re-applies. */
export async function reset(db: Db): Promise<void> {
  await db.exec('DROP SCHEMA IF EXISTS base_signal_private CASCADE');
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}
