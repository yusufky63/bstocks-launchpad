'use client';

import { ArrowUpRight } from 'lucide-react';

import { PairBadge } from '@/components/markets/market-rows';
import { TokenLogo } from '@/components/stock/stock-coin';
import { TradePanel } from '@/components/trade/trade-panel';
import { Banner, PriceChange, TxLink } from '@/components/ui/display';
import { Module, Skeleton } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';
import { formatUsd } from '@/lib/format';
import { useToken } from '@/lib/queries';
import { tradeMarketOf } from '@/lib/trade-market';
import type { TokenResponse } from '@/lib/types';

import { useEmbedHidden } from './embed-sections';
import { postToHost } from './embed-shell';

/**
 * The trade widget: one token's buy / sell panel. It follows a launch through the same states as
 * the token page (submitted, live but not indexed, indexed) and keeps the panel mounted across them.
 */
export function TradeWidget({ address, initialData, initialSide = 'buy' }: { address: string; initialData: TokenResponse; initialSide?: 'buy' | 'sell' }) {
  const { data } = useToken(address, initialData);
  const view = data ?? initialData;
  const market = tradeMarketOf(view);
  const hidden = useEmbedHidden();

  return (
    <Module ticks>
      {!hidden('header') && <WidgetHeader view={view} pageUrl={`${publicEnv.appUrl}/token/${address}`} />}
      {view.status === 'pending' ? (
        <div className="p-4 flex flex-col gap-3">
          <p className="text-[13px] text-ink-secondary">The launch transaction is in flight. Trading opens here by itself as soon as the block lands.</p>
          {view.txHash && <TxLink hash={view.txHash}>Launch transaction</TxLink>}
          <Skeleton className="h-40" />
        </div>
      ) : market ? (
        <TradePanel market={market} initialSide={initialSide} onTraded={({ txHash, side }) => postToHost({ type: 'swap', token: address, side, txHash })} />
      ) : (
        <div className="p-4">
          <Banner tone="warning">This stock is not configured for trading on this site yet.</Banner>
        </div>
      )}
    </Module>
  );
}

function WidgetHeader({ view, pageUrl }: { view: TokenResponse; pageUrl: string }) {
  const indexed = view.status === 'indexed' ? view.market : null;
  const launch = view.status === 'indexing' ? view.launch : null;
  const symbol = indexed?.symbol ?? launch?.symbol ?? '';
  const name = indexed?.name ?? launch?.name ?? 'New token';

  return (
    <div className="flex items-center gap-3 p-3 border-b border-line">
      <TokenLogo src={indexed?.imageUrl} symbol={symbol || '…'} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="display text-[18px] leading-tight truncate">{name}</span>
          {symbol && <span className="font-mono text-[12px] text-ink-muted shrink-0">{symbol}</span>}
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap text-[12px]">
          {indexed ? (
            <>
              <PairBadge market={indexed} />
              <span className="font-mono num text-ink-secondary">{formatUsd(indexed.priceUsd)}</span>
              <PriceChange value={indexed.change24hPercent} />
            </>
          ) : launch ? (
            <span className="eyebrow">
              <span className="live-dot" /> Live · history loading
            </span>
          ) : (
            <span className="eyebrow">
              <span className="live-dot" /> Launch submitted · waiting for Base
            </span>
          )}
        </div>
      </div>
      <a
        href={pageUrl}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Open the full token page"
        title="Chart, holders and fees on BStocks Launchpad"
        className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-[6px] border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast"
      >
        <ArrowUpRight size={15} strokeWidth={1.75} />
      </a>
    </div>
  );
}
