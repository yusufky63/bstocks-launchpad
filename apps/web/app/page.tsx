import { HomeView } from '@/components/home/home-view';
import { getDb } from '@/lib/db.server';
import { publicEnv } from '@/lib/env';
import { readMarketsResponse } from '@/lib/markets.server';
import { readMarketCached } from '@/lib/token.server';

export const dynamic = 'force-dynamic';

/**
 * Only the market list is fetched server-side; the platform stats load client-side via useStats so
 * the first render never waits on the six aggregate queries. Both are timeout-guarded either way.
 * The featured token is read on its own too: the list is the newest hundred, and it will not always
 * be among them.
 */
export default async function HomePage() {
  const [markets, featured] = await Promise.all([
    readMarketsResponse({ limit: 100 }),
    // A failed read only costs the card its first paint; the client list fills it in.
    Promise.resolve()
      .then(async () => readMarketCached(await getDb(), publicEnv.featuredToken))
      .catch(() => null),
  ]);
  return <HomeView initialMarkets={markets ?? undefined} initialFeatured={featured} />;
}
