'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Tabs } from '@/components/ui/controls';
import { AddressLabel, TimeAgo, TxLink } from '@/components/ui/display';
import { Badge, Empty, KeyValue, Skeleton, cx } from '@/components/ui/primitives';
import { formatDateTime, formatNumber, formatPct, formatRatio, formatUsd, shortAddress } from '@/lib/format';
import { useHolders, useSwaps } from '@/lib/queries';
import type { MarketView, TokenDetails } from '@/lib/types';
import { ExternalLink } from 'lucide-react';

type Tab = 'trades' | 'holders' | 'fees' | 'details';

export function TokenRecords({ market, links, fees }: { market: MarketView; links?: TokenDetails['links']; fees?: ReactNode }) {
  const [tab, setTab] = useState<Tab>('trades');
  const swaps = useSwaps(market.token, tab === 'trades');
  const holders = useHolders(market.token, tab === 'holders');

  return (
    <>
      <Tabs<Tab>
        ariaLabel="Token records"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'trades', label: 'Trades' },
          { id: 'holders', label: `Holders · ${formatNumber(market.holders, 0)}` },
          { id: 'fees', label: 'Fees & pool' },
          { id: 'details', label: 'Details' },
        ]}
      />

      {tab === 'trades' &&
        (swaps.isError ? (
          <Empty>Trades could not be loaded.</Empty>
        ) : swaps.isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (swaps.data?.swaps.length ?? 0) === 0 ? (
          <Empty>No trades yet. The first swap shows up here within a few blocks.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[90px_60px_1fr_1fr_1fr_1fr_110px_40px] gap-3 px-4 py-2 border-b border-line font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <span>Time</span>
                <span>Side</span>
                <span className="text-right">{market.symbol}</span>
                <span className="text-right">{market.stock.symbol}</span>
                <span className="text-right">Value</span>
                <span className="text-right">Price</span>
                <span>Trader</span>
                <span />
              </div>
              {swaps.data!.swaps.map((s) => (
                <div key={`${s.txHash}:${s.logIndex}`} className="rail grid grid-cols-[90px_60px_1fr_1fr_1fr_1fr_110px_40px] gap-3 px-4 py-2 border-b border-line last:border-b-0 items-center text-[13px] hover:bg-surface transition-fast">
                  <span className="font-mono text-[11px] text-ink-muted" title={formatDateTime(s.blockTime)}>
                    <TimeAgo value={s.blockTime} placeholder="…" />
                  </span>
                  <span className={cx('font-medium inline-flex items-center gap-1', s.side === 'buy' ? 'text-positive-fg' : 'text-danger-fg')}>
                    {s.side === 'buy' ? 'Buy' : 'Sell'}
                    {s.isCreator && <Badge tone="warning" title="This trade was made by the token creator">dev</Badge>}
                  </span>
                  <span className="font-mono num text-right">{formatNumber(s.amountToken, 2)}</span>
                  <span className="font-mono num text-right">{formatNumber(s.amountStock, 6)}</span>
                  <span className="font-mono num text-right">{formatUsd(s.amountUsd)}</span>
                  <span className="font-mono num text-right text-ink-secondary">{formatUsd(s.priceUsd)}</span>
                  <span className="font-mono text-[12px]">{s.trader ? <Link href={`/wallet/${s.trader}`} className={cx('hover:text-primary', s.isCreator && 'text-warning-fg')}>{s.isCreator ? 'creator' : shortAddress(s.trader)}</Link> : <span className="text-ink-muted">—</span>}</span>
                  <TxLink hash={s.txHash} className="text-[12px]">
                    tx
                  </TxLink>
                </div>
              ))}
            </div>
          </div>
        ))}

      {tab === 'holders' &&
        (holders.isError ? (
          <Empty>Holders could not be loaded.</Empty>
        ) : holders.isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (holders.data?.holders.length ?? 0) === 0 ? (
          <Empty>No holders indexed yet.</Empty>
        ) : (
          <div>
            {holders.data?.concentration && (
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border-b border-line">
                {[
                  { label: 'Top 10 wallets hold', value: `${formatPct(holders.data.concentration.top10OfCirculatingPercent, { sign: false })} of circulating`, sub: `${formatPct(holders.data.concentration.top10Percent, { sign: false })} of supply` },
                  { label: 'In the pool', value: formatPct(holders.data.concentration.poolPercent, { sign: false }), sub: 'locked liquidity' },
                  { label: 'Creator holds', value: formatPct(holders.data.concentration.creatorPercent, { sign: false }), sub: 'of supply' },
                  { label: 'Circulating', value: formatPct(holders.data.concentration.circulatingPercent, { sign: false }), sub: `${formatNumber(holders.data.concentration.holders, 0)} wallets` },
                ].map((c) => (
                  <div key={c.label} className="bg-canvas px-4 py-2.5 min-w-0">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
                    <dd className="display num text-[18px] leading-none mt-1 truncate">{c.value}</dd>
                    <dd className="font-mono text-[11px] text-ink-muted mt-0.5">{c.sub}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="grid grid-cols-[40px_1fr_130px_110px_80px] gap-3 px-4 py-2 border-b border-line font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">
              <span>#</span>
              <span>Holder</span>
              <span className="text-right">Balance</span>
              <span className="text-right">Value</span>
              <span className="text-right">Share</span>
            </div>
            {holders.data!.holders.map((h) => (
              <div key={h.address} className="rail grid grid-cols-[40px_1fr_130px_110px_80px] gap-3 px-4 py-2 border-b border-line last:border-b-0 items-center text-[13px] hover:bg-surface transition-fast">
                <span className="font-mono num text-ink-muted">{h.rank}</span>
                <span className="flex items-center gap-2 min-w-0">
                  <Link href={`/wallet/${h.address}`} className="font-mono text-[12px] hover:text-primary truncate">
                    {shortAddress(h.address, 6)}
                  </Link>
                  {h.label && <Badge tone={h.label === 'Creator' ? 'primary' : 'neutral'}>{h.label}</Badge>}
                </span>
                <span className="font-mono num text-right">{formatNumber(h.balance, 0)}</span>
                <span className="font-mono num text-right">{formatUsd(market.priceUsd === null ? null : h.balance * market.priceUsd)}</span>
                <span className="font-mono num text-right">{formatPct(h.sharePercent, { sign: false })}</span>
              </div>
            ))}
          </div>
        ))}

      {tab === 'fees' && fees}

      {tab === 'details' && (
        <div className="p-4 flex flex-col gap-1">
          {market.description && <p className="text-[14px] text-ink-secondary mb-2 max-w-[70ch]">{market.description}</p>}
          {links && (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {(
                [
                  ['DexScreener', links.dexscreener],
                  ['GeckoTerminal', links.geckoterminal],
                  ['Uniswap', links.uniswap],
                  ['BaseScan', links.basescan],
                ] as const
              ).map(([label, href]) => (
                <a key={label} href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] border border-line text-[12px] text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
                  <ExternalLink size={12} strokeWidth={1.75} /> {label}
                </a>
              ))}
            </div>
          )}
          <KeyValue k="Website" v={market.website ? <a href={market.website} target="_blank" rel="noreferrer noopener" className="text-primary">{market.website}</a> : '—'} mono={false} />
          <KeyValue k="X" v={market.twitter ? <a href={market.twitter} target="_blank" rel="noreferrer noopener" className="text-primary">{market.twitter}</a> : '—'} mono={false} />
          <KeyValue k="Telegram" v={market.telegram ? <a href={market.telegram} target="_blank" rel="noreferrer noopener" className="text-primary">{market.telegram}</a> : '—'} mono={false} />
          <KeyValue k="Profile" v={market.profileUpdatedAt ? `Updated by the creator with a signed message · ${formatDateTime(market.profileUpdatedAt)}` : 'As written in the launch metadata'} mono={false} />
          <KeyValue k="Token" v={<AddressLabel address={market.token} explorer kind="token" chars={8} />} />
          <KeyValue k="Creator" v={<Link href={`/wallet/${market.creator}`} className="text-primary font-mono">{shortAddress(market.creator, 8)}</Link>} />
          <KeyValue k="Paired stock" v={<span className="inline-flex items-center gap-2">{market.stock.symbol} <AddressLabel address={market.stock.address} explorer kind="token" showCopy={false} /></span>} />
          <KeyValue k="Pool id" v={`${market.poolId.slice(0, 10)}…${market.poolId.slice(-6)}`} />
          <KeyValue k="Launch tx" v={<TxLink hash={market.txHash}>{shortAddress(market.txHash, 8)}</TxLink>} />
          <KeyValue k="Launched" v={formatDateTime(market.launchedAt)} />
          <KeyValue k="Supply" v="1,000,000,000 · 18 decimals · no admin, no mint, no pause" mono={false} />
          <KeyValue k="Liquidity" v="Whole supply in a single-sided Uniswap v4 position held by the factory. No function can withdraw it." mono={false} />
          <KeyValue k="Fees" v={`1% of every swap in ${market.stock.symbol}: 70% to the creator, 30% to the platform. 99% anti-snipe fee decaying to 1% over the first 20 s.`} mono={false} />
          <KeyValue k="Opening" v={`Priced from the Chainlink ${market.stock.ticker} feed so the token opened at a $5,000 valuation. Now ${formatRatio(market.priceInStock, market.stock.symbol)} per token.`} mono={false} />
        </div>
      )}
    </>
  );
}
