'use client';

import { ArrowRight, Coins, Lock, Percent, Search, Timer, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { MarketDetailRow } from '@/components/markets/market-rows';
import { TokenLogo } from '@/components/stock/stock-coin';
import { AnimatedNumber, PriceChange } from '@/components/ui/display';
import { LinkButton, Module, ModuleHeader } from '@/components/ui/primitives';
import { formatNumber, formatUsd } from '@/lib/format';
import { useMarkets, useStats } from '@/lib/queries';
import type { MarketView, MarketsResponse, StatsResponse } from '@/lib/types';

export function HomeView({ initialMarkets, initialStats }: { initialMarkets?: MarketsResponse; initialStats?: StatsResponse }) {
  // Home opts out of the fast poll: the lists should stay still, not reshuffle under the reader.
  const { data: markets, isSuccess: marketsRead } = useMarkets({}, initialMarkets, { refetchInterval: 60_000 });
  const { data: stats } = useStats(initialStats);
  const rows = useMemo(() => markets?.markets ?? [], [markets]);
  const newest = rows.slice(0, 8);
  const top = useMemo(() => [...rows].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) || (b.fdvUsd ?? 0) - (a.fdvUsd ?? 0)).slice(0, 5), [rows]);
  const movers = useMemo(
    () =>
      rows
        .filter((m) => m.change24hPercent !== null && m.trades24h > 0)
        .sort((a, b) => Math.abs(b.change24hPercent ?? 0) - Math.abs(a.change24hPercent ?? 0))
        .slice(0, 8),
    [rows],
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="border border-line rounded-[8px] ticks overflow-hidden bg-canvas">
        <div className="p-6 md:p-12 grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-8 items-center">
          <div className="reveal">
            <div className="eyebrow mb-4">01 — Built on Base</div>
            <h1 className="display text-[44px] md:text-[72px] leading-[0.92]">
              Tokens,
              <br />
              priced in <span className="text-primary">real stocks</span>.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[15px] md:text-[17px] text-ink-secondary">
              Launch a token that trades against NVDAc, TSLAc or any Coinbase tokenized stock. Fixed supply, liquidity locked forever, and every swap pays its 1% fee in the stock itself: 70% to the creator.
            </p>
            <div className="mt-7 flex flex-col sm:flex-row gap-2">
              <LinkButton href="/create" variant="primary" size="lg">
                Create a token <ArrowRight size={16} strokeWidth={1.75} />
              </LinkButton>
              <LinkButton href="/markets" size="lg">
                Browse markets
              </LinkButton>
              <LinkButton href="/how-it-works" variant="ghost" size="lg">
                How it works
              </LinkButton>
            </div>
            <dl className="mt-7 grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line rounded-[8px] overflow-hidden max-w-[640px]">
              {[
                // The front door states the scale reached so far; "Top movers" below carries the day.
                // rows is one page, so it would report 100 for any larger platform; show nothing rather than a wrong count.
                { label: 'Tokens launched', value: stats ? formatNumber(stats.launches, 0) : '—' },
                { label: 'Volume · all', value: stats?.volumeUsd ? formatUsd(stats.volumeUsd, { compact: true }) : '—' },
                { label: 'Trades · all', value: stats?.swaps ? formatNumber(stats.swaps, 0) : '—' },
                { label: 'Traders', value: stats ? formatNumber(stats.traders, 0) : '—' },
              ].map((c) => (
                <div key={c.label} className="bg-canvas/85 px-3 py-2.5">
                  <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
                  <dd className="display num text-[20px] leading-none mt-1">{c.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <TopTokens tokens={top} />
        </div>
      </section>

      <Module>
        <ModuleHeader
          index="02"
          title="Newest launches"
          action={
            <Link href="/markets" className="text-[13px] text-primary font-medium">
              All markets →
            </Link>
          }
        />
        {newest.map((m) => (
          <MarketDetailRow key={m.token} market={m} />
        ))}
        {newest.length === 0 && (
          <p className="px-4 py-6 text-[14px] text-ink-secondary">
            {marketsRead ? (
              <>
                No tokens yet.{' '}
                <Link href="/create" className="text-primary font-medium">
                  Create the first one →
                </Link>
              </>
            ) : (
              // Only claim the launchpad is empty once a read actually came back empty. A failed
              // markets read used to put "No tokens yet" on the front page of a live launchpad.
              'Loading the latest launches…'
            )}
          </p>
        )}
      </Module>

      <Module>
        <ModuleHeader index="03" title="Top movers · 24h" action={<Link href="/stats" className="text-[13px] text-primary font-medium">Stats & activity →</Link>} />
        {movers.map((m) => (
          <MarketDetailRow key={m.token} market={m} />
        ))}
        {movers.length === 0 && <p className="px-4 py-6 text-[14px] text-ink-secondary">Movers appear once tokens have traded in the last 24 hours.</p>}
      </Module>

      <Module ticks>
        <ModuleHeader title="How it works" action={<Link href="/how-it-works" className="text-[13px] text-primary font-medium">Full walkthrough →</Link>} />
        <ol className="grid grid-cols-2 md:grid-cols-3">
          {HOW_IT_WORKS.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.title} className="p-5 border-b border-r border-line [&:nth-child(2n)]:border-r-0 [&:nth-child(n+5)]:border-b-0 md:[&:nth-child(2n)]:border-r md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0 flex flex-col gap-2 min-h-[150px]">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-primary">0{i + 1}</span>
                  <Icon size={16} strokeWidth={1.75} className="text-ink-muted" />
                </div>
                <div className="display-medium text-[17px]">{s.title}</div>
                <p className="text-[13px] text-ink-secondary leading-snug max-w-[34ch]">{s.body}</p>
              </li>
            );
          })}
        </ol>
      </Module>
    </div>
  );
}

const HOW_IT_WORKS = [
  { icon: Search, title: 'Pick a stock', body: '13 Coinbase tokenized stocks on Base, each with a Chainlink price feed, are the only quote assets.' },
  { icon: Coins, title: 'Launch in one transaction', body: 'A zero-admin B20 token with exactly one billion supply is created and its pool opens at a $5,000 valuation.' },
  { icon: Lock, title: 'Liquidity is locked', body: 'The whole supply sits in a single-sided Uniswap v4 position held by the factory. No function can withdraw it.' },
  { icon: Timer, title: 'Snipers pay 99%', body: 'The swap fee starts at 99% and falls to 1% over the first twenty seconds, so bots cannot front-run the launch.' },
  { icon: Percent, title: 'Fees in the stock', body: 'Every buy and sell pays 1% in the stock. The hook keeps it as claims: 70% for the creator, 30% for the platform.' },
  { icon: Wallet, title: 'Claim any time', body: 'Creators claim their NVDAc, TSLAc or other stock from their wallet page. No lockups, no auth, no middleman.' },
];

/** The hero visual: the busiest tokens right now, ranked by 24h volume. */
function TopTokens({ tokens }: { tokens: MarketView[] }) {
  return (
    <div className="border border-line rounded-[8px] bg-canvas overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line flex items-center justify-between">
        <span className="eyebrow">Top tokens · 24h</span>
        <Link href="/markets" className="text-[12px] text-primary font-medium">
          All →
        </Link>
      </div>
      {tokens.length === 0 && (
        <p className="px-4 py-8 text-[13px] text-ink-secondary">
          The first tokens will show up here.{' '}
          <Link href="/create" className="text-primary font-medium">
            Create one →
          </Link>
        </p>
      )}
      {tokens.map((m, i) => (
        <Link key={m.token} href={`/token/${m.token}`} className="rail grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
          <span className="font-mono text-[11px] text-ink-muted">{i + 1}</span>
          <span className="flex items-center gap-2.5 min-w-0">
            <TokenLogo src={m.imageUrl} symbol={m.symbol} size={30} />
            <span className="min-w-0">
              <span className="block font-medium text-[14px] leading-tight truncate">{m.name}</span>
              <span className="block font-mono text-[11px] text-ink-muted truncate">
                {m.symbol}/{m.stock.symbol} · {m.volume24hStock > 0 ? `${formatUsd(m.volume24hUsd, { compact: true })} vol` : 'no trades 24h'} · {formatNumber(m.holders, 0)} holders
              </span>
            </span>
          </span>
          <span className="text-right">
            <span className="block display num text-[15px]">
              <AnimatedNumber value={m.priceUsd} format={(v) => formatUsd(v)} />
            </span>
            <PriceChange value={m.change24hPercent} className="text-[11px]" />
          </span>
        </Link>
      ))}
    </div>
  );
}
