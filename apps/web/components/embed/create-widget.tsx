'use client';

import { useRouter } from 'next/navigation';

import { CreateForm } from '@/components/create/create-form';
import { withEmbedParams, type EmbedPicker } from '@/lib/embed';
import type { StocksResponse } from '@/lib/types';

import { useEmbedHidden } from './embed-sections';
import { postToHost } from './embed-shell';

/**
 * The create widget: the site's own create form. The launch goes from the visitor's wallet straight
 * to the factory, so the visitor is the creator and keeps the creator's share, whatever site it is
 * on. Once the wallet returns a hash the frame moves to that token's trade widget.
 */
export function CreateWidget({ initialStocks, stockPicker = 'grid', lockedStock = null }: { initialStocks?: StocksResponse; stockPicker?: EmbedPicker; lockedStock?: string | null }) {
  const router = useRouter();
  const hidden = useEmbedHidden();
  return (
    <div className="flex flex-col gap-3">
      {!hidden('header') && (
        <div className="px-1">
          <div className="eyebrow">BStocks Launchpad · Create</div>
          <h1 className="display text-[22px] leading-tight mt-1">Launch a stock-paired token</h1>
        </div>
      )}
      <CreateForm
        compact
        initialStocks={initialStocks}
        stockPicker={stockPicker}
        lockedStock={lockedStock}
        onLaunched={({ token, txHash }) => {
          const address = token.toLowerCase();
          postToHost({ type: 'launch', token: address, txHash });
          router.push(withEmbedParams(`/embed/trade/${address}?tx=${txHash}`, window.location.search));
        }}
      />
    </div>
  );
}
