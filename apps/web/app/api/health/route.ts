import { readCursor, SCHEMA_VERSION } from '@stockpair/core/db';

import { json } from '@/lib/api.server';
import { getPublicClient, serverDeployments } from '@/lib/chain.server';
import { getDb } from '@/lib/db.server';
import { appliedSchema, unknownLaunchHooks } from '@/lib/health.server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const deployments = serverDeployments();
  const deployment = deployments.at(-1) ?? null;
  let database: 'ok' | 'error' = 'ok';
  let cursor: { nextBlock: string; updatedAt: string } | null = null;
  let schemaVersion: number | null = null;
  let unknownHooks: string[] | null = null;
  try {
    const db = await getDb();
    const row = await readCursor(db);
    cursor = row ? { nextBlock: row.next_block, updatedAt: new Date(row.updated_at).toISOString() } : null;
    // Each check stands alone: an older schema may lack the columns the next one reads.
    schemaVersion = await appliedSchema(db).catch(() => null);
    unknownHooks = await unknownLaunchHooks(db, deployments.map((d) => d.hook)).catch(() => null);
  } catch {
    database = 'error';
  }
  let head: string | null = null;
  try {
    head = (await getPublicClient().getBlockNumber()).toString();
  } catch {
    head = null;
  }
  const lag = head && cursor ? BigInt(head) - BigInt(cursor.nextBlock) : null;
  // This build reads the schema it ships with; an older one fails every market read until migrated.
  const schemaCurrent = schemaVersion !== null && schemaVersion >= SCHEMA_VERSION;
  return json({
    ok: database === 'ok' && schemaCurrent && (unknownHooks === null || unknownHooks.length === 0),
    database,
    schema: { applied: schemaVersion, required: SCHEMA_VERSION },
    contracts: deployment
      ? { factory: deployment.factory, hook: deployment.hook, router: deployment.router, deployBlock: deployment.deployBlock.toString() }
      : null,
    // Every deployment still live, oldest first; `contracts` above is the newest, where launches go.
    deployments: deployments.map((d) => ({ factory: d.factory, hook: d.hook, router: d.router, deployBlock: d.deployBlock.toString() })),
    // Launch hooks with no configured deployment: those tokens cannot trade or claim through this site.
    unknownLaunchHooks: unknownHooks,
    indexer: cursor ? { ...cursor, lagBlocks: lag === null ? null : (lag < 0n ? 0n : lag).toString() } : null,
    head,
  });
}
