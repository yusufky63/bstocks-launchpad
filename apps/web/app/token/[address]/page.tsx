import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Address } from 'viem';

import { findStock } from '@stockpair/core';

import { TokenView } from '@/components/token/token-view';
import { parseAddressParam } from '@/lib/api.server';
import { cached, TTL } from '@/lib/cache.server';
import { getDb } from '@/lib/db.server';
import { readLaunchOnchain } from '@/lib/onchain.server';
import { readMarketCached, readTokenCached, readTokenDetails } from '@/lib/token.server';
import type { TokenResponse } from '@/lib/types';

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

  const db = await getDb();
  const indexed = await readTokenCached(db, token);
  let initial: TokenResponse;
  if (indexed) {
    initial = { status: 'indexed', market: indexed.market, details: await readTokenDetails(db, indexed.market), launch: indexed.launch, profile: indexed.profile };
  } else {
    // Freshly launched tokens exist onchain before the indexer stores them.
    const onchain = await cached(`onchain:${token}`, TTL.chain, () => readLaunchOnchain(token as Address));
    if (onchain) {
      const stock = findStock(onchain.stock);
      initial = { status: 'indexing', launch: { ...onchain, stockSymbol: stock?.symbol ?? null, stockTicker: stock?.ticker ?? null } };
    } else if (tx && /^0x[0-9a-fA-F]{64}$/u.test(tx)) {
      // The create form sends people here as soon as the wallet returns a hash, before the block lands.
      initial = { status: 'pending', token, txHash: tx.toLowerCase() };
    } else {
      notFound();
    }
  }
  return <TokenView address={token} initialData={initial} />;
}
