'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Tabs } from '@/components/ui/controls';
import { AddressLabel, TimeAgo, TxLink } from '@/components/ui/display';
import { Empty, KeyValue, Skeleton, cx } from '@/components/ui/primitives';
import { formatDateTime, formatNumber, formatPct, formatRatio, formatUsd, shortAddress } from '@/lib/format';
import { useHolders, useSwaps } from '@/lib/queries';
import type { MarketView, TokenDetails } from '@/lib/types';
import { ExternalLink } from 'lucide-react';

type Tab = 'trades' | 'holders' | 'fees' | 'details';

/** A small marker for a trade made by the token's creator. */
function DevTag() {
  return (
    <span title="Made by the token creator" className="text-[9px] font-mono uppercase tracking-[0.08em] px-1 leading-[14px] rounded-[3px] bg-warning-soft text-warning-fg">
      dev
    </span>
  );
}

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
          <div>
            {swaps.data!.swaps.some((s) => s.isCreator) && (
              <p className="px-4 py-2 border-b border-line font-mono text-[11px] text-warning-fg">
                {swaps.data!.swaps.filter((s) => s.isCreator).length} dev {swaps.data!.swaps.filter((s) => s.isCreator).length === 1 ? 'trade' : 'trades'} by the creator, of the last {swaps.data!.swaps.length}
              </p>
            )}
            {swaps.data!.swaps.map((s) => (
              <div key={`${s.txHash}:${s.logIndex}`} className="rail flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                <span className="shrink-0 flex flex-col items-start gap-0.5 w-11">
                  <span className={cx('font-medium text-[13px]', s.side === 'buy' ? 'text-positive-fg' : 'text-danger-fg')}>{s.side === 'buy' ? 'Buy' : 'Sell'}</span>
                  {s.isCreator && <DevTag />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono num text-[13px] truncate">
                    {formatNumber(s.amountToken, 2)} <span className="text-ink-muted">{market.symbol}</span>
                  </span>
                  <span className="block font-mono text-[11px] text-ink-muted truncate" title={formatDateTime(s.blockTime)}>
                    <TimeAgo value={s.blockTime} placeholder="…" />
                    {' · '}
                    {s.trader ? (
                      <Link href={`/wallet/${s.trader}`} className={cx('hover:text-primary', s.isCreator && 'text-warning-fg')}>
                        {s.isCreator ? 'creator' : shortAddress(s.trader)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </span>
                </span>
                <span className="text-right shrink-0">
                  <span className="block font-mono num text-[13px]">{formatUsd(s.amountUsd)}</span>
                  <span className="block font-mono text-[11px] text-ink-muted">{formatNumber(s.amountStock, 6)} {market.stock.symbol}</span>
                </span>
                <TxLink hash={s.txHash} className="shrink-0 text-[12px]">
                  tx
                </TxLink>
              </div>
            ))}
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
            {holders.data!.holders.map((h) => (
              <div key={h.address} className="rail flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                <span className="font-mono num text-[12px] text-ink-muted w-6 shrink-0 text-right">{h.rank}</span>
                <span className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                  <Link href={`/wallet/${h.address}`} className="font-mono text-[12px] hover:text-primary truncate">
                    {shortAddress(h.address, 6)}
                  </Link>
                  {h.label && (
                    <span className={cx('text-[9px] font-mono uppercase tracking-[0.08em] px-1 leading-[15px] rounded-[3px]', h.label === 'Creator' ? 'bg-primary-soft text-primary' : 'bg-surface-muted text-ink-secondary')}>{h.label}</span>
                  )}
                </span>
                <span className="text-right shrink-0">
                  <span className="block font-mono num text-[13px]">{formatUsd(market.priceUsd === null ? null : h.balance * market.priceUsd)}</span>
                  <span className="block font-mono text-[11px] text-ink-muted">
                    {formatNumber(h.balance, 0)} · {formatPct(h.sharePercent, { sign: false })}
                  </span>
                </span>
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
