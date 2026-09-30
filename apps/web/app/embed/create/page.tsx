import type { Metadata } from 'next';

import { CreateWidget } from '@/components/embed/create-widget';
import { EmbedShell } from '@/components/embed/embed-shell';
import { parseAddressParam } from '@/lib/api.server';
import { parseEmbedAccent, parseEmbedEligibility, parseEmbedHide, parseEmbedPicker } from '@/lib/embed';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Create widget' };

type Props = { searchParams: Promise<{ eligibility?: string; hide?: string; accent?: string; stock?: string; picker?: string }> };

export default async function EmbedCreatePage({ searchParams }: Props) {
  const [{ eligibility, hide, accent, stock, picker }, stocks] = await Promise.all([searchParams, readStocksResponse()]);
  const hidden = parseEmbedHide(hide);
  // Hiding the picker fixes the stock the host named; without one the picker stays.
  const lockedStock = hidden.includes('stocks') && stock ? parseAddressParam(stock) : null;
  return (
    <EmbedShell widget="create" eligibility={parseEmbedEligibility(eligibility)} hide={hidden} accent={parseEmbedAccent(accent)}>
      <CreateWidget initialStocks={stocks ?? undefined} stockPicker={parseEmbedPicker(picker)} lockedStock={lockedStock} />
    </EmbedShell>
  );
}
