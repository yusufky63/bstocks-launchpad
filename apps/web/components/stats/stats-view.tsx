'use client';

import Link from 'next/link';

import { StockTile, TokenLogo } from '@/components/stock/stock-coin';
import { TimeAgo, TxLink } from '@/components/ui/display';
import { Badge, Empty, KeyValue, Module, ModuleHeader, PageTitle, Skeleton, StatStrip, cx } from '@/components/ui/primitives';
import { formatDateTime, formatNumber, formatUsd, shortAddress } from '@/lib/format';
import { useActivity, useStats } from '@/lib/queries';
import type { ActivityItem, ActivityResponse, StatsResponse } from '@/lib/types';

export function StatsView({ initialStats, initialActivity }: { initialStats: StatsResponse; initialActivity: ActivityResponse }) {
  const { data: stats } = useStats(initialStats);
  const { data: activity } = useActivity({ limit: 60 }, initialActivity);
  const s = stats ?? initialStats;
  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index="06 — Stats & activity"
        title="The launchpad so far"
        lead={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span className="live-dot" /> Every figure is counted from confirmed Base events · updated <TimeAgo value={s.asOf} placeholder="just now" />
            {s.firstLaunchAt && <> · first launch {formatDateTime(s.firstLaunchAt)}</>}
          </span>
        }
      />

      <StatStrip
        columns="grid-cols-2 md:grid-cols-4 lg:grid-cols-8"
        cells={[
          { label: 'Tokens', value: formatNumber(s.launches, 0) },
          { label: 'Launched · 24h', value: formatNumber(s.launches24h, 0) },
          { label: 'Creators', value: formatNumber(s.creators, 0) },
          { label: 'Traders', value: formatNumber(s.traders, 0) },
          { label: 'Holders', value: formatNumber(s.holders, 0) },
          { label: 'Trades · all', value: formatNumber(s.swaps, 0) },
          { label: 'Volume · all', value: formatUsd(s.volumeUsd, { compact: true }) },
          { label: 'Volume · 24h', value: formatUsd(s.volume24hUsd, { compact: true }) },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        <Module ticks>
          <ModuleHeader index="01" title="Activity" action={<span className="font-mono text-[11px] text-ink-muted">launches and swaps · live</span>} />
          {!activity && (
            <div className="p-4 flex flex-col gap-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {activity && activity.items.length === 0 && <Empty>Nothing yet. The first launch will show up here.</Empty>}
          {activity?.items.map((item) => <ActivityRow key={`${item.txHash}:${item.kind}:${item.token}`} item={item} />)}
        </Module>

        <div className="flex flex-col gap-5">
          <Module ticks>
            <ModuleHeader title="Fees" />
            <div className="module-grid grid-cols-3 rounded-none border-0 border-b border-line">
              <div className="p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Paid · all</div>
                <div className="display num text-[18px] leading-tight">{formatUsd(s.feesUsd, { compact: true })}</div>
              </div>
              <div className="p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">To creators</div>
                <div className="display num text-[18px] leading-tight text-positive-fg">{formatUsd(s.creatorFeesUsd, { compact: true })}</div>
              </div>
              <div className="p-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">To platform</div>
                <div className="display num text-[18px] leading-tight">{formatUsd(s.platformFeesUsd, { compact: true })}</div>
              </div>
            </div>
            <div className="px-4 py-2">
              {s.feesByStock.length === 0 && <p className="py-2 text-[13px] text-ink-secondary">No fees yet.</p>}
              {s.feesByStock.map((f) => (
                <KeyValue key={f.stock} k={<span className="inline-flex items-center gap-2"><StockTile ticker={f.ticker} size={16} className="rounded-[3px]" /> {f.symbol}</span>} v={`${formatNumber(f.amount, 6)} · ${formatUsd(f.usd)}`} />
              ))}
            </div>
            <p className="px-4 py-2.5 border-t border-line text-[11px] text-ink-muted">1% of every swap, paid in the stock: 70% to the creator, 30% to the platform.</p>
          </Module>

          <Module>
            <ModuleHeader title="Volume by stock" />
            <div className="px-4 py-2">
              {s.volumeByStock.length === 0 && <p className="py-2 text-[13px] text-ink-secondary">No trades yet.</p>}
              {[...s.volumeByStock]
                .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
                .map((v) => (
                  <KeyValue key={v.stock} k={<span className="inline-flex items-center gap-2"><StockTile ticker={v.ticker} size={16} className="rounded-[3px]" /> {v.symbol}</span>} v={`${formatUsd(v.usd, { compact: true })} · 24h ${formatUsd(v.dayUsd, { compact: true })}`} />
                ))}
            </div>
          </Module>

          <Module>
            <ModuleHeader title="Tokens by stock" />
            <div className="px-4 py-2">
              {s.launchesByStock.map((l) => (
                <KeyValue key={l.stock} k={<Link href={`/markets?stock=${l.stock}`} className="hover:text-primary">{l.symbol}</Link>} v={String(l.launches)} />
              ))}
              {s.launchesByStock.length === 0 && <p className="py-2 text-[13px] text-ink-secondary">No tokens yet.</p>}
            </div>
          </Module>
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const launch = item.kind === 'launch';
  return (
    <div className="rail grid grid-cols-[72px_minmax(0,1fr)_auto_36px] gap-3 px-4 py-2.5 border-b border-line last:border-b-0 items-center text-[13px]">
      <span className="flex items-center gap-1">
        <Badge tone={launch ? 'primary' : item.side === 'buy' ? 'positive' : 'danger'}>{launch ? 'launch' : item.side}</Badge>
      </span>
      <span className="flex items-center gap-3 min-w-0">
        <TokenLogo src={item.imageUrl} symbol={item.symbol} size={28} />
        <span className="min-w-0">
          <Link href={`/token/${item.token}`} className="block font-medium hover:text-primary truncate">
            {item.name} <span className="text-ink-muted font-mono text-[11px]">{item.symbol}/{item.stock.symbol}</span>
          </Link>
          <span className="block font-mono text-[11px] text-ink-muted truncate">
            {item.actor ? (
              <Link href={`/wallet/${item.actor}`} className={cx('hover:text-primary', item.isCreator && !launch && 'text-warning-fg')}>
                {launch ? `by ${shortAddress(item.actor)}` : item.isCreator ? 'creator (dev)' : shortAddress(item.actor)}
              </Link>
            ) : (
              '—'
            )}{' '}
            · <TimeAgo value={item.at} placeholder="…" />
          </span>
        </span>
      </span>
      <span className="text-right font-mono num">
        {launch ? (
          <span className="text-ink-secondary">new pool</span>
        ) : (
          <>
            <span className="block">{formatUsd(item.amountUsd)}</span>
            <span className="block text-ink-muted text-[11px]">
              {formatNumber(item.amountToken, 0)} {item.symbol}
            </span>
          </>
        )}
      </span>
      <TxLink hash={item.txHash} className="text-[12px]">
        tx
      </TxLink>
    </div>
  );
}
