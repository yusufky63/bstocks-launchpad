'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { TokenLogo } from '@/components/stock/stock-coin';
import { PriceChange } from '@/components/ui/display';
import { formatUsd } from '@/lib/format';
import { useMarkets } from '@/lib/queries';
import type { MarketsResponse } from '@/lib/types';

/**
 * Global marquee above the header: the tokens launched here, with their last price and 24h move.
 * Pure CSS animation, pauses on hover; the data is the same /api/markets object the pages read.
 */
export function TopTicker({ initialMarkets }: { initialMarkets?: MarketsResponse }) {
  const { data } = useMarkets({ limit: 40 }, initialMarkets, { refetchInterval: 30_000 });
  const markets = data?.markets ?? [];
  const cells = markets.map((m) => (
    <Link key={m.token} href={`/token/${m.token}`} className="inline-flex items-center gap-2 px-3 h-8 border-r border-line hover:text-primary transition-fast" title={`${m.name} · paired with ${m.stock.symbol}`}>
      <TokenLogo src={m.imageUrl} symbol={m.symbol} size={16} className="rounded-[3px]" />
      <span className="font-medium">{m.symbol}</span>
      <span className="text-ink-muted normal-case tracking-normal">/{m.stock.symbol}</span>
      <span className="num">{formatUsd(m.priceUsd)}</span>
      <PriceChange value={m.change24hPercent} digits={1} />
    </Link>
  ));
  return (
    <div className="bg-canvas font-mono text-[11px] uppercase tracking-[0.04em]">
      <div className="border-b border-line flex items-stretch">
        {cells.length > 0 ? (
          <Track cells={cells} seconds={Math.max(40, cells.length * 6)} />
        ) : (
          <Link href="/create" className="inline-flex items-center gap-2 px-3 h-8 text-ink-muted hover:text-primary transition-fast">
            No tokens yet · create the first one →
          </Link>
        )}
      </div>
    </div>
  );
}

function Track({ cells, seconds }: { cells: ReactNode[]; seconds: number }) {
  return (
    <div className="tape flex-1">
      <div className="tape-track" style={{ animationDuration: `${seconds}s` }}>
        {cells}
        {cells.map((c, i) => (
          <span key={`dup-${i}`} aria-hidden className="contents">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}
