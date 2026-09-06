'use client';

import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { AnimatedNumber, TimeAgo } from '@/components/ui/display';
import { Badge, PageTitle, StatStrip, cx } from '@/components/ui/primitives';
import { formatUsd } from '@/lib/format';
import { useStocks } from '@/lib/queries';
import type { StocksResponse } from '@/lib/types';

import { StockTile } from './stock-coin';

export function StocksView({ initialStocks }: { initialStocks: StocksResponse }) {
  const { data } = useStocks(initialStocks);
  const stocks = data?.stocks ?? [];
  const live = stocks.filter((s) => s.feedStatus === 'live').length;
  const launches = stocks.reduce((sum, s) => sum + s.launches, 0);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index="03 — Stocks"
        title="Quote stocks"
        lead="Coinbase-issued B20 tokens on Base, each backed 1:1 by shares and priced by a Chainlink feed that updates during US trading hours and holds the last close in between. Every token on StockPair trades against one of these."
      />
      <StatStrip
        cells={[
          { label: 'Stocks', value: String(stocks.length) },
          { label: 'Open for launches', value: `${stocks.filter((s) => s.enabled).length} / ${stocks.length}` },
          { label: 'Tokens paired', value: String(launches) },
          { label: 'Decimals', value: '8' },
        ]}
      />
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-line border border-line rounded-[8px] overflow-hidden ticks">
        {stocks.map((s) => (
          <li key={s.address} className="bg-canvas">
            <Link href={`/markets?stock=${s.address}`} className={cx('rail flex items-center gap-4 p-4 h-full hover:bg-surface transition-fast', !s.enabled && 'opacity-60')}>
              <StockTile ticker={s.ticker} size={56} className="rounded-full" muted={!s.enabled} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="display text-[20px] leading-none">{s.ticker}</span>
                  <span className="font-mono text-[11px] text-ink-muted">{s.symbol}</span>
                </span>
                <span className="block text-[13px] text-ink-secondary truncate mt-0.5">{s.name}</span>
                <span className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="display num text-[18px] leading-none">
                    <AnimatedNumber value={s.priceUsd} format={(v) => formatUsd(v)} />
                  </span>
                  {s.enabled ? (
                    <Badge tone={s.feedStatus === 'live' ? 'positive' : 'neutral'} title={s.feedUpdatedAt ? `Chainlink updated ${new Date(s.feedUpdatedAt).toUTCString()}` : undefined}>
                      {s.feedStatus === 'live' ? 'feed live' : s.feedStatus === 'paused' ? 'last close' : 'no reading'}
                    </Badge>
                  ) : (
                    <Badge tone="warning" title="Coinbase has not minted this stock on Base yet; launches against it are closed until it is issued">
                      not issued yet
                    </Badge>
                  )}
                </span>
                <span className="block font-mono text-[11px] text-ink-muted mt-1.5">
                  {s.launches} token{s.launches === 1 ? '' : 's'} paired{s.feedUpdatedAt ? <> · feed <TimeAgo value={s.feedUpdatedAt} /></> : null}
                </span>
              </span>
              <ArrowUpRight size={16} strokeWidth={1.75} className="text-ink-muted shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-muted">
        Addresses and feeds are read from the StockPair factory on Base. Coinbase tokenized stocks are available only to eligible persons outside the United States; see{' '}
        <a href="https://www.base.org/stocks" target="_blank" rel="noreferrer noopener" className="text-primary">
          base.org/stocks
        </a>
        .
      </p>
    </div>
  );
}
