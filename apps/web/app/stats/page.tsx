import type { Metadata } from 'next';

import { StatsView } from '@/components/stats/stats-view';
import { getDb } from '@/lib/db.server';
import { readActivity, readStats } from '@/lib/stats.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Stats & activity' };

export default async function StatsPage() {
  const db = await getDb();
  const [stats, activity] = await Promise.all([readStats(db), readActivity(db, { limit: 60 })]);
  return <StatsView initialStats={stats ?? undefined} initialActivity={activity ?? undefined} />;
}
