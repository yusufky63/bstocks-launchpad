import 'server-only';

import type { Db } from '@stockpair/core/db';

/** The schema version the database has fully applied, or null when there is none. */
export async function appliedSchema(db: Db): Promise<number | null> {
  const rows = await db.query<{ version: string | null }>('SELECT max(version)::text AS version FROM schema_version');
  const value = rows[0]?.version;
  return value == null ? null : Number(value);
}

/**
 * Hooks recorded on indexed launches that this server has no deployment for. Such a token cannot be
 * quoted, traded or claimed here, so a deployment list that dropped an older entry shows up here.
 */
export async function unknownLaunchHooks(db: Db, known: readonly string[]): Promise<string[]> {
  const rows = await db.query<{ hook: string }>('SELECT DISTINCT lower(hook) AS hook FROM launches WHERE hook IS NOT NULL ORDER BY 1');
  const configured = new Set(known.map((h) => h.toLowerCase()));
  return rows.map((r) => r.hook).filter((h) => !configured.has(h));
}
