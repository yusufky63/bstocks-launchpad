import { json } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { readStats } from '@/lib/stats.server';

export const dynamic = 'force-dynamic';

/** Platform totals: launches, traders, volume and fees, every figure counted from confirmed events. */
export async function GET(): Promise<Response> {
  return json(await readStats(await getDb()));
}
