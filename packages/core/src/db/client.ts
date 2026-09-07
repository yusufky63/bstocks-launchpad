/**
 * A tiny database adapter so the same query code runs on a real PostgreSQL
 * (production, via postgres.js) and on an embedded PostgreSQL (tests, via PGlite).
 * Queries are plain SQL strings with $1..$n parameters; rows are plain objects with
 * bigint columns normalised to strings and numeric columns kept as strings.
 */

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function normalizeRow<T extends Row>(row: Row): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out as T;
}

export function normalizeRows<T extends Row>(rows: readonly Row[]): T[] {
  return rows.map((row) => normalizeRow<T>(row));
}

function sslFromUrl(url: string): false | 'require' {
  try {
    const parsed = new URL(url);
    const mode = parsed.searchParams.get('sslmode');
    const host = parsed.hostname;
    if (mode === 'disable') return false;
    if (mode === 'require' || mode === 'verify-full' || mode === 'prefer') return 'require';
    return host === 'localhost' || host === '127.0.0.1' ? false : 'require';
  } catch {
    return false;
  }
}

/** Production adapter over postgres.js. */
/**
 * Postgres via postgres.js. `max` is the connections this process may hold: keep it tiny on
 * serverless (every instance has its own pool and Supabase's pooler caps the total) and small for
 * the single indexer. Works with both pooler modes because statements are never prepared.
 */
export async function createPostgresDb(url: string, options: { max?: number } = {}): Promise<Db> {
  const postgres = (await import('postgres')).default;
  const sql = postgres(url, {
    max: options.max ?? 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: sslFromUrl(url),
    transform: { undefined: null },
    onnotice: () => undefined,
  });

  /**
   * Queries are run one at a time per client.
   *
   * Supabase's transaction pooler cannot serve concurrent queries from a single client: postgres.js
   * pipelines them down one connection, and measured against production six issued together never
   * came back at all, while the same six run in sequence finished in milliseconds. Serialising here
   * rather than at every call site means code can still say `Promise.all` for what it needs without
   * that quietly turning into a stall, and it is close to free now that the app runs in the
   * database's own region.
   */
  const wrap = (client: typeof sql): Db => {
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(run: () => Promise<T>): Promise<T> => {
      const result = queue.then(run, run);
      // The queue must survive a failed query, so swallow the outcome for the next in line only.
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    return {
      async query<T extends Row>(text: string, params: readonly unknown[] = []) {
        const rows = await serial(() => client.unsafe(text, params as never[]));
        return normalizeRows<T>(rows as unknown as Row[]);
      },
      async exec(text: string) {
        await serial(() => client.unsafe(text));
      },
      async transaction<T>(fn: (tx: Db) => Promise<T>) {
        // The transaction gets its own connection, and its own queue via this same wrapper.
        return serial(() => client.begin(async (tx) => fn(wrap(tx as unknown as typeof sql))) as Promise<T>);
      },
      async close() {
        await client.end({ timeout: 5 });
      },
    };
  };
  return wrap(sql);
}

/** Embedded adapter over PGlite for tests. */
export async function createEmbeddedDb(): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  // Keep 64-bit integers and numerics as strings, exactly like postgres.js does.
  const identity = (value: string) => value;
  const pg = await PGlite.create({
    parsers: { [types.INT8]: identity, [types.NUMERIC]: identity },
  });

  type Queryable = {
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(text: string): Promise<unknown>;
  };
  const wrap = (client: Queryable, closer?: () => Promise<void>): Db => ({
    async query<T extends Row>(text: string, params: readonly unknown[] = []) {
      const result = await client.query<Row>(text, [...params]);
      return normalizeRows<T>(result.rows);
    },
    async exec(text: string) {
      await client.exec(text);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return pg.transaction(async (tx) => fn(wrap(tx as unknown as Queryable))) as Promise<T>;
    },
    async close() {
      if (closer) await closer();
    },
  });
  return wrap(pg as unknown as Queryable, () => pg.close());
}

/** Picks the adapter from the environment: DATABASE_URL in production, embedded otherwise. */
export async function createDbFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Db> {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is not set.');
  return createPostgresDb(url);
}
