import { error, json } from '@/lib/api.server';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const stocks = await readStocksResponse();
  if (!stocks) return error(503, 'STOCKS_UNAVAILABLE', 'Stocks could not be read in time.');
  return json(stocks);
}
