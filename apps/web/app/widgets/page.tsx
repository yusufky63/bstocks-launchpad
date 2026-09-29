import type { Metadata } from 'next';

import { PageTitle } from '@/components/ui/primitives';
import { WidgetBuilder } from '@/components/widgets/widget-builder';
import { parseAddressParam } from '@/lib/api.server';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Widgets',
  description: 'Put a buy / sell panel for any launchpad token, or the create form, on your own site with one iframe.',
};

type Props = { searchParams: Promise<{ token?: string }> };

export default async function WidgetsPage({ searchParams }: Props) {
  const [{ token }, stocks] = await Promise.all([searchParams, readStocksResponse()]);
  const initialToken = token ? (parseAddressParam(token) ?? undefined) : undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="09 — Widgets"
        title="Trade and launch from your own site"
        lead="One iframe each: a buy / sell panel for any token here, or the create form. Visitors sign in their own wallet and the transaction goes straight to the contracts; your site never holds funds, keys or approvals."
      />
      <WidgetBuilder initialToken={initialToken} initialStocks={stocks ?? undefined} />
    </div>
  );
}
