'use client';

import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

import { AnimatedNumber, TimeAgo } from '@/components/ui/display';
import { Badge, PageTitle, StatStrip, cx } from '@/components/ui/primitives';
import { formatUsd } from '@/lib/format';
import { useStocks } from '@/lib/queries';
import type { StocksResponse } from '@/lib/types';

import { StockTile } from './stock-coin';

export function StocksView({ initialStocks }: { initialStocks?: StocksResponse }) {
  const { data } = useStocks(initialStocks);
  // Issued stocks first; the ones Coinbase has not minted yet sink to the end.
  const stocks = [...(data?.stocks ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const live = stocks.filter((s) => s.feedStatus === 'live').length;
  const launches = stocks.reduce((sum, s) => sum + s.launches, 0);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index="03 — Stocks"
        title="Quote stocks"
        lead="Coinbase-issued B20 tokens on Base, each backed 1:1 by shares and priced by a Chainlink feed that updates during US trading hours and holds the last close in between. Every token launched here trades against one of these."
      />
      <StatStrip
        cells={[
          { label: 'Stocks', value: String(stocks.length) },
          { label: 'Open for launches', value: `${stocks.filter((s) => s.enabled).length} / ${stocks.length}` },
          { label: 'Tokens paired', value: String(launches) },
          { label: 'Feeds live now', value: `${live} / ${stocks.length}` },
        ]}
      />
      <div className="border border-line rounded-[8px] overflow-hidden ticks bg-canvas">
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 -mr-px -mb-px">
        {stocks.map((s) => (
          <li key={s.address} className="bg-canvas relative border-r border-b border-line">
            {s.enabled && (
              <a
                href={`https://basestocks.finance/stocks/${s.address}`}
                target="_blank"
                rel="noreferrer noopener"
                title={`Buy ${s.ticker} on BStocks`}
                className="absolute top-3 right-3 z-10 inline-flex items-center gap-1 h-8 px-2.5 rounded-[6px] border border-line bg-canvas text-[12px] font-medium text-ink-secondary hover:text-primary hover:border-primary transition-fast"
              >
                Buy <ArrowUpRight size={13} strokeWidth={1.75} />
              </a>
            )}
            <Link href={`/markets?stock=${s.address}`} className={cx('rail flex items-center gap-4 p-4 pr-4 h-full hover:bg-surface transition-fast', !s.enabled && 'opacity-60')}>
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
                  {/* A live or held feed needs no badge: the "feed 2h ago" line below already says
                      when it last moved, and a green pill on every row is noise. No reading at all
                      is different — the price above has nothing behind it, so that one stays. */}
                  {s.enabled && s.feedStatus === 'unknown' && <Badge tone="neutral">no reading</Badge>}
                  {!s.enabled && (
                    <Badge tone="warning" title="Coinbase has not minted this stock on Base yet; launches against it are closed until it is issued">
                      not issued yet
                    </Badge>
                  )}
                </span>
                <span className="block font-mono text-[11px] text-ink-muted mt-1.5">
                  {s.launches} token{s.launches === 1 ? '' : 's'} paired{s.feedUpdatedAt ? <> · feed <TimeAgo value={s.feedUpdatedAt} /></> : null}
                </span>
              </span>
            </Link>
          </li>
        ))}
        </ul>
      </div>
      <p className="text-[12px] text-ink-muted">
        Addresses and feeds are read from the launchpad's factory on Base. Coinbase tokenized stocks are available only to eligible persons outside the United States; see{' '}
        <a href="https://www.base.org/stocks" target="_blank" rel="noreferrer noopener" className="text-primary">
          base.org/stocks
        </a>
        .
      </p>
    </div>
  );
}
