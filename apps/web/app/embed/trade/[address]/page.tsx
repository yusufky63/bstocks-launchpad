import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmbedShell } from '@/components/embed/embed-shell';
import { TradeWidget } from '@/components/embed/trade-widget';
import { parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { parseEmbedAccent, parseEmbedEligibility, parseEmbedHide, parseEmbedSide } from '@/lib/embed';
import { readTokenResponse } from '@/lib/token.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Trade widget' };

type Props = { params: Promise<{ address: string }>; searchParams: Promise<{ tx?: string; side?: string; eligibility?: string; hide?: string; accent?: string }> };

export default async function EmbedTradePage({ params, searchParams }: Props) {
  const [{ address }, { tx, side, eligibility, hide, accent }] = await Promise.all([params, searchParams]);
  const token = parseAddressParam(address);
  if (!token) notFound();
  const initial = await readTokenResponse(await getDb(), token, tx);
  if (!initial) notFound();
  return (
    <EmbedShell widget="trade" eligibility={parseEmbedEligibility(eligibility)} hide={parseEmbedHide(hide)} accent={parseEmbedAccent(accent)}>
      <TradeWidget address={token} initialData={initial} initialSide={parseEmbedSide(side)} />
    </EmbedShell>
  );
}
