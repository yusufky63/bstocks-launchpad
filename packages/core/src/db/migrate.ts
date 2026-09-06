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

/** Applies the schema (idempotent) and seeds the stock registry. */
export async function migrate(db: Db): Promise<void> {
  await db.exec(await schemaSql());
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
