import { readCursor } from '@stockpair/core/db';

import { json } from '@/lib/api.server';
import { getPublicClient, serverDeployment } from '@/lib/chain.server';
import { getDb } from '@/lib/db.server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const deployment = serverDeployment();
  let database: 'ok' | 'error' = 'ok';
  let cursor: { nextBlock: string; updatedAt: string } | null = null;
  try {
    const row = await readCursor(await getDb());
    cursor = row ? { nextBlock: row.next_block, updatedAt: new Date(row.updated_at).toISOString() } : null;
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
  return json({
    ok: database === 'ok',
    database,
    contracts: deployment
      ? { factory: deployment.factory, hook: deployment.hook, router: deployment.router, deployBlock: deployment.deployBlock.toString() }
      : null,
    indexer: cursor ? { ...cursor, lagBlocks: lag === null ? null : (lag < 0n ? 0n : lag).toString() } : null,
    head,
  });
}
