import { HomeView } from '@/components/home/home-view';
import { readMarketsResponse } from '@/lib/markets.server';

export const dynamic = 'force-dynamic';

/**
 * Only the market list is fetched server-side; the platform stats load client-side via useStats so
 * the first render never waits on the six aggregate queries. Both are timeout-guarded either way.
 */
export default async function HomePage() {
  const markets = await readMarketsResponse({ limit: 100 });
  return <HomeView initialMarkets={markets ?? undefined} />;
}
