import type { Metadata } from 'next';

import { CreateWidget } from '@/components/embed/create-widget';
import { EmbedShell } from '@/components/embed/embed-shell';
import { parseEmbedAccent, parseEmbedEligibility, parseEmbedHide } from '@/lib/embed';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Create widget' };

type Props = { searchParams: Promise<{ eligibility?: string; hide?: string; accent?: string }> };

export default async function EmbedCreatePage({ searchParams }: Props) {
  const [{ eligibility, hide, accent }, stocks] = await Promise.all([searchParams, readStocksResponse()]);
  return (
    <EmbedShell widget="create" eligibility={parseEmbedEligibility(eligibility)} hide={parseEmbedHide(hide)} accent={parseEmbedAccent(accent)}>
      <CreateWidget initialStocks={stocks ?? undefined} />
    </EmbedShell>
  );
}
