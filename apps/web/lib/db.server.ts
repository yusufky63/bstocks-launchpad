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
    // `max` is deliberately small. Opening a connection to the database costs a TLS handshake plus
    // pooler auth, measured at ~3.7s from outside its region, and postgres.js opens a new connection
    // for every concurrent query up to this limit. Raising it makes a burst of parallel queries pay
    // that handshake several times over instead of sharing one warm connection. The functions are
    // pinned to the database's region in vercel.json, which is what actually makes this cheap.
    registry.__stockpairDb = createPostgresDb(url, { max: 3 });
  }
  return registry.__stockpairDb;
}

/** Tests inject an embedded database here. */
export function setDbForTests(db: Db | null): void {
  registry.__stockpairDbOverride = db ?? undefined;
}
