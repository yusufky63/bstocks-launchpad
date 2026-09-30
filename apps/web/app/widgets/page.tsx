import type { Metadata } from 'next';

import { LinkButton, PageTitle } from '@/components/ui/primitives';
import { ApiGuide } from '@/components/widgets/api-guide';
import { WidgetBuilder } from '@/components/widgets/widget-builder';
import { parseAddressParam } from '@/lib/api.server';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Widgets',
  description: 'Put a buy / sell panel for any launchpad token, or the create form, on your own site with one iframe, or build your own interface on the API.',
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
        lead="One iframe each: a buy / sell panel for any token here, or the create form. Or build your own interface on the API. Either way visitors sign in their own wallet and the transaction goes straight to the contracts; your site never holds funds, keys or approvals."
        action={<LinkButton href="#api">Use the API</LinkButton>}
      />
      <WidgetBuilder initialToken={initialToken} initialStocks={stocks ?? undefined} />
      <ApiGuide />
    </div>
  );
}
