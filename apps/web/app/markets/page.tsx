import type { Metadata } from 'next';

import { MarketsView } from '@/components/markets/markets-view';
import { readMarketsResponse } from '@/lib/markets.server';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Markets' };

export default async function MarketsPage({ searchParams }: { searchParams: Promise<{ stock?: string }> }) {
  const { stock } = await searchParams;
  const initialStock = stock && /^0x[0-9a-fA-F]{40}$/u.test(stock) ? stock.toLowerCase() : undefined;
  const [markets, stocks] = await Promise.all([readMarketsResponse({ limit: 100 }), readStocksResponse()]);
  return <MarketsView initialMarkets={markets ?? undefined} initialStocks={stocks ?? undefined} initialStock={initialStock} />;
}
