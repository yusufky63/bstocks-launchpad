import { HomeView } from '@/components/home/home-view';
import { getDb } from '@/lib/db.server';
import { readMarketsResponse } from '@/lib/markets.server';
import { readStats } from '@/lib/stats.server';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [markets, stats] = await Promise.all([readMarketsResponse({ limit: 100 }), getDb().then(readStats)]);
  return <HomeView initialMarkets={markets} initialStats={stats} />;
}
