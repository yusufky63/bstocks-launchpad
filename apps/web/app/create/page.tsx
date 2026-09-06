import type { Metadata } from 'next';

import { CreateForm } from '@/components/create/create-form';
import { PageTitle } from '@/components/ui/primitives';
import { readStocksResponse } from '@/lib/stocks.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Create a token' };

export default async function CreatePage() {
  const stocks = await readStocksResponse();
  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="04 — Create" title="Create a stock-paired token" lead="Fill in the basics, pick the stock it trades against, confirm once in your wallet. The pool opens in the same transaction." />
      <CreateForm initialStocks={stocks} />
    </div>
  );
}
