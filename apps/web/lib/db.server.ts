import 'server-only';

import { createPostgresDb, type Db } from '@stockpair/core/db';

const registry = globalThis as typeof globalThis & { __stockpairDb?: Promise<Db>; __stockpairDbOverride?: Db };

/** Shared database handle for API routes and server components. */
export function getDb(): Promise<Db> {
  if (registry.__stockpairDbOverride) return Promise.resolve(registry.__stockpairDbOverride);
  if (!registry.__stockpairDb) {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error('DATABASE_URL is not set.');
    // Serverless: one small pool per instance; Supabase's transaction pooler multiplexes the rest.
    //
    // One connection per instance, on purpose. postgres.js opens a separate connection for every
    // concurrent query, and against Supabase's transaction pooler a burst of them stalls: pages
    // built from a single query stayed fast while the ones firing six at once timed out. Pipelining
    // several queries down one connection avoids that, and since the functions now run in the
    // database's region a serialised round trip costs milliseconds rather than the ~350ms it did
    // from outside. It also means an instance holds one pooler slot instead of three.
    registry.__stockpairDb = createPostgresDb(url, { max: 1 });
  }
  return registry.__stockpairDb;
}

/** Tests inject an embedded database here. */
export function setDbForTests(db: Db | null): void {
  registry.__stockpairDbOverride = db ?? undefined;
}
