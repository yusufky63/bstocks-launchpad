'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Named, TimeAgo, TxLink } from '@/components/ui/display';
import { Empty, Skeleton, cx } from '@/components/ui/primitives';
import { formatCompact, formatDateTime, formatNumber, formatSupplyPct, formatUsd } from '@/lib/format';
import { usePendingBurns, withPendingBurns, withPendingBurnSummary } from '@/lib/pending-burns';
import { apiGet, useBurns } from '@/lib/queries';
import type { BurnsResponse, BurnView, MarketView } from '@/lib/types';

const FETCH = 100;

/** Tokens holders sent to 0x…dEaD: totals, the largest burners, and every burn. */
export function BurnsTab({ market, perPage }: { market: Pick<MarketView, 'token' | 'symbol'>; perPage: number }) {
  const burns = useBurns(market.token);
  const pending = usePendingBurns(market.token);
  const [older, setOlder] = useState<BurnView[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [page, setPage] = useState(0);

  const indexed = burns.data?.burns;
  const rows = useMemo(() => {
    const head = indexed ? withPendingBurns(indexed, pending) : [];
    const seen = new Set(head.map((b) => `${b.txHash}:${b.logIndex}`));
    return [...head, ...older.filter((b) => !seen.has(`${b.txHash}:${b.logIndex}`))];
  }, [indexed, pending, older]);
  const summary = burns.data?.summary ? withPendingBurnSummary(burns.data.summary, pending) : null;

  if (burns.isError) return <Empty>Burns could not be loaded.</Empty>;
  if (burns.isLoading) {
    return (
      <div className="p-4 flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  const fetchOlder = async () => {
    const last = rows[rows.length - 1];
    if (!last || loadingMore) return 0;
    setLoadingMore(true);
    try {
      const next = await apiGet<BurnsResponse>(`/api/tokens/${market.token}/burns?limit=${FETCH}&before=${last.blockNumber}&beforeLog=${last.logIndex}`);
      setOlder((prev) => [...prev, ...next.burns]);
      if (next.burns.length < FETCH) setExhausted(true);
      return next.burns.length;
    } catch {
      return 0;
    } finally {
      setLoadingMore(false);
    }
  };
  const canPageIndexed = (indexed?.length ?? 0) >= FETCH && !exhausted;
  const shown = rows.slice(page * perPage, (page + 1) * perPage);
  const hasNext = rows.length > (page + 1) * perPage || canPageIndexed;
  const next = async () => {
    if (rows.length <= (page + 1) * perPage && (await fetchOlder()) === 0) return;
    setPage((p) => p + 1);
  };

  return (
    <div>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border-b border-line">
        {[
          { label: 'Burned', value: <span title={`${formatNumber(summary?.burned ?? 0, 2)} ${market.symbol}`}>{formatCompact(summary?.burned ?? 0)} {market.symbol}</span>, sub: `${formatSupplyPct(summary?.supplyPercent ?? 0)} of supply` },
          { label: 'Burns', value: formatNumber(summary?.burns ?? 0, 0), sub: summary?.lastBurnAt ? <>last <TimeAgo value={summary.lastBurnAt} placeholder="…" /></> : 'none yet' },
          { label: 'Burners', value: formatNumber(summary?.burners ?? 0, 0), sub: 'wallets' },
          { label: 'Sent to', value: '0x…dEaD', sub: 'nobody holds its key' },
        ].map((c) => (
          <div key={c.label} className="bg-canvas px-4 py-2.5 min-w-0">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
            <dd className="display num text-[18px] leading-none mt-1 truncate">{c.value}</dd>
            <dd className="font-mono text-[11px] text-ink-muted mt-0.5">{c.sub}</dd>
          </div>
        ))}
      </dl>

      {rows.length === 0 ? (
        <Empty>Nobody has burned {market.symbol} yet. A holder can burn from the Burn button at the top of this page.</Empty>
      ) : (
        <>
          {summary && summary.top.length > 1 && (
            <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
              <span className="uppercase tracking-[0.12em]">Top burners</span>
              {summary.top.slice(0, 5).map((t, i) => (
                <Link key={t.burner} href={`/wallet/${t.burner}`} className="hover:text-primary">
                  {i + 1}. <Named address={t.burner} /> · {formatSupplyPct(t.supplyPercent)}
                </Link>
              ))}
            </div>
          )}
          {shown.map((b) => (
            <div key={`${b.txHash}:${b.logIndex}`} className="rail flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
              <span className="min-w-0 flex-1">
                <span className="block font-mono num text-[13px] truncate">
                  {formatNumber(b.amount, 2)} <span className="text-ink-muted">{market.symbol}</span> <span className="text-ink-muted text-[11px]">· {formatSupplyPct(b.supplyPercent)} of supply</span>
                </span>
                <span className="block font-mono text-[11px] text-ink-muted truncate" title={formatDateTime(b.blockTime)}>
                  {b.pending && (
                    <>
                      <span title="Your burn, read from its receipt. It is replaced by the indexed record a few seconds after the block is confirmed." className="text-[9px] uppercase tracking-[0.08em] px-1 leading-[14px] rounded-[3px] bg-primary-soft text-primary">
                        pending
                      </span>{' '}
                    </>
                  )}
                  <TimeAgo value={b.blockTime} placeholder="…" /> ·{' '}
                  <Link href={`/wallet/${b.burner}`} className={cx('hover:text-primary', b.isCreator && 'text-warning-fg')}>
                    {b.isCreator ? 'creator' : <Named address={b.burner} />}
                  </Link>
                </span>
              </span>
              <span className="text-right shrink-0">
                <span className="block font-mono num text-[13px]">{formatUsd(b.valueUsd)}</span>
                <span className="block font-mono text-[11px] text-ink-muted">{b.valueUsd === null ? 'no trade before it' : 'when burned'}</span>
              </span>
              <TxLink hash={b.txHash} className="shrink-0 text-[12px]">
                tx
              </TxLink>
            </div>
          ))}
          {(page > 0 || hasNext) && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line">
              <span className="font-mono text-[11px] text-ink-muted">{loadingMore ? 'Loading…' : `${page * perPage + 1}–${page * perPage + shown.length}${summary ? ` of ${formatNumber(summary.burns, 0)}` : ''}`}</span>
              <span className="flex items-center gap-2">
                <button type="button" className="h-8 px-3 rounded-[6px] border border-line text-[12px] font-medium text-ink-secondary disabled:opacity-40 enabled:hover:border-line-strong enabled:hover:text-ink" disabled={page === 0 || loadingMore} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  Newer
                </button>
                <button type="button" className="h-8 px-3 rounded-[6px] border border-line text-[12px] font-medium text-ink-secondary disabled:opacity-40 enabled:hover:border-line-strong enabled:hover:text-ink" disabled={!hasNext || loadingMore} onClick={() => void next()}>
                  Older
                </button>
              </span>
            </div>
          )}
        </>
      )}
      <p className="px-4 py-2.5 border-t border-line text-[11px] text-ink-muted">
        A burn is a transfer to 0x…dEaD. The token has no burn function anyone may call, so its total supply onchain stays the same; FDV here is still priced on the full supply. The few wei the launch itself sent there are not counted.
      </p>
    </div>
  );
}
