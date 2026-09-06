import { json } from '@/lib/api.server';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return json(await readStocksResponse());
}
