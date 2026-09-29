import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { TokenView } from '@/components/token/token-view';
import { parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { readMarketCached, readTokenResponse } from '@/lib/token.server';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ address: string }>; searchParams: Promise<{ tx?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return { title: 'Token' };
  const market = await readMarketCached(await getDb(), token);
  if (!market) return { title: 'Token' };
  const title = `${market.name} (${market.symbol}) / ${market.stock.symbol}`;
  const description = `${market.name} trades against ${market.stock.ticker} on the BStocks launchpad: fixed supply, locked liquidity, fees paid in the stock.`;
  return { title, description, openGraph: { title, description } };
}

export default async function TokenPage({ params, searchParams }: Props) {
  const [{ address }, { tx }] = await Promise.all([params, searchParams]);
  const token = parseAddressParam(address);
  if (!token) notFound();
  const initial = await readTokenResponse(await getDb(), token, tx);
  if (!initial) notFound();
  return <TokenView address={token} initialData={initial} />;
}
