import { error, json } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { readStats } from '@/lib/stats.server';

export const dynamic = 'force-dynamic';

/** Platform totals: launches, traders, volume and fees, every figure counted from confirmed events. */
export async function GET(): Promise<Response> {
  const stats = await readStats(await getDb());
  // 503 rather than a zeroed body: the client keeps the last good totals instead of showing $0.
  if (!stats) return error(503, 'STATS_UNAVAILABLE', 'Stats could not be read in time. Showing the last known figures.');
  return json(stats);
}
