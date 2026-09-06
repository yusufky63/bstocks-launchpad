import type { Metadata } from 'next';

import { StocksView } from '@/components/stock/stocks-view';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Stocks' };

export default async function StocksPage() {
  const stocks = await readStocksResponse();
  return <StocksView initialStocks={stocks} />;
}
