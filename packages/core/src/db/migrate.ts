import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './client';
import { BASE_STOCKS } from '../stocks';

export const SCHEMA_VERSION = 3;

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

/**
 * Applies the schema (idempotent) and seeds the stock registry.
 *
 * An index that cannot be built right now — a statement timeout, or a lock still held by a process
 * that was killed mid-write — is logged and skipped rather than thrown. Without an index the
 * queries it serves fall back to a sort; with a throw here the indexer would crash-loop and stop
 * following the chain, which is far worse. The next start retries it.
 */
export async function migrate(db: Db, log: Log = () => undefined): Promise<void> {
  const { core, indexes } = splitIndexes(await schemaSql());
  await db.exec(core);
  for (const statement of indexes) {
    try {
      // The timeout rides in the same simple-query batch so it lands on this statement's connection.
      await db.exec(`SET statement_timeout = '120s';\n${statement}`);
    } catch (error) {
      log('index skipped', { statement, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await db.query(
    'INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
    [SCHEMA_VERSION],
  );
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
