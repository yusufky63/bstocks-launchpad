'use client';

import Link from 'next/link';

import { StockTile, TokenLogo } from '@/components/stock/stock-coin';
import { AnimatedNumber, PriceChange, TimeAgo, Named } from '@/components/ui/display';
import { Badge, cx } from '@/components/ui/primitives';
import { formatNumber, formatUsd, shortAddress } from '@/lib/format';
import type { MarketView } from '@/lib/types';

/** The pair chip: stock icon and ticker with a dot that says whether its Chainlink feed is updating. */
export function PairBadge({ market, className }: { market: Pick<MarketView, 'stock' | 'stockFeedStatus'>; className?: string }) {
  const live = market.stockFeedStatus === 'live';
  return (
    <Badge tone={live ? 'primary' : 'neutral'} className={cx('pl-1', className)} title={live ? `${market.stock.symbol} feed updating` : market.stockFeedStatus === 'holding' ? `${market.stock.symbol} feed holds the last close (market closed)` : 'No feed reading yet'}>
      <StockTile ticker={market.stock.ticker} size={14} className="rounded-[3px] border-0" />
      {market.stock.symbol}
      <span className={cx('inline-block w-1.5 h-1.5 rounded-full', live ? 'bg-positive-fg' : 'bg-ink-muted')} aria-hidden />
    </Badge>
  );
}

/** Compact list row: logo, name, pair, price and 24h. */
export function MarketMiniRow({ market }: { market: MarketView }) {
  return (
    <Link href={`/token/${market.token}`} className="rail flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
      <span className="flex items-center gap-3 min-w-0">
        <TokenLogo src={market.imageUrl} symbol={market.symbol} size={28} />
        <span className="min-w-0">
          <span className="block font-medium text-[14px] leading-tight truncate">
            {market.name} <span className="text-ink-muted font-mono text-[11px]">{market.symbol}</span>
          </span>
          <span className="block text-[12px] text-ink-secondary truncate">
            vs {market.stock.symbol} · launched <TimeAgo value={market.launchedAt} placeholder="…" />
          </span>
        </span>
      </span>
      <span className="text-right shrink-0">
        <span className="block display num text-[15px]">
          <AnimatedNumber value={market.priceUsd} format={(v) => formatUsd(v)} />
        </span>
        <PriceChange value={market.change24hPercent} className="text-[12px]" />
      </span>
    </Link>
  );
}

/**
 * Richer list row for Home: logo, name, pair, creator, then price / 24h / volume / FDV / holders.
 * Figures collapse to price and 24h on narrow screens.
 */
export function MarketDetailRow({ market, rank }: { market: MarketView; rank?: number }) {
  return (
    <Link href={`/token/${market.token}`} className="rail grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_110px_90px_110px_90px_80px] items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
      <span className="flex items-center gap-3 min-w-0">
        {rank !== undefined && <span className="font-mono text-[11px] text-ink-muted w-4 shrink-0">{rank}</span>}
        <TokenLogo src={market.imageUrl} symbol={market.symbol} size={36} />
        <span className="min-w-0">
          <span className="block font-medium text-[15px] leading-tight truncate">
            {market.name} <span className="text-ink-muted font-mono text-[11px]">{market.symbol}</span>
          </span>
          <span className="flex items-center gap-2 mt-0.5 text-[12px] text-ink-secondary min-w-0">
            <PairBadge market={market} />
            <span className="truncate">
              by <Named address={market.creator} className="font-mono" /> · <TimeAgo value={market.launchedAt} placeholder="…" />
            </span>
          </span>
        </span>
      </span>
      <span className="text-right">
        <span className="block display num text-[16px]">
          <AnimatedNumber value={market.priceUsd} format={(v) => formatUsd(v)} />
        </span>
        <PriceChange value={market.change24hPercent} className="text-[12px] md:hidden" />
      </span>
      <span className="hidden md:block text-right">
        <PriceChange value={market.change24hPercent} />
      </span>
      <span className="hidden md:block text-right font-mono num text-[12px]">
        <span className="block">{market.volume24hStock > 0 ? formatUsd(market.volume24hUsd, { compact: true }) : '—'}</span>
        <span className="block text-ink-muted">{market.trades24h > 0 ? `${market.trades24h} trades` : 'vol 24h'}</span>
      </span>
      <span className="hidden md:block text-right font-mono num text-[12px]">
        <span className="block">{formatUsd(market.fdvUsd, { compact: true })}</span>
        <span className="block text-ink-muted">FDV</span>
      </span>
      <span className="hidden md:block text-right font-mono num text-[12px]">
        <span className="block">{formatNumber(market.holders, 0)}</span>
        <span className="block text-ink-muted">holders</span>
      </span>
    </Link>
  );
}
