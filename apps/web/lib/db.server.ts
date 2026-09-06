import 'server-only';

import { createPostgresDb, type Db } from '@stockpair/core/db';

const registry = globalThis as typeof globalThis & { __stockpairDb?: Promise<Db>; __stockpairDbOverride?: Db };

/** Shared database handle for API routes and server components. */
export function getDb(): Promise<Db> {
  if (registry.__stockpairDbOverride) return Promise.resolve(registry.__stockpairDbOverride);
  if (!registry.__stockpairDb) {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL is not set.');
    registry.__stockpairDb = createPostgresDb(url);
  }
  return registry.__stockpairDb;
}

/** Tests inject an embedded database here. */
export function setDbForTests(db: Db | null): void {
  registry.__stockpairDbOverride = db ?? undefined;
}
