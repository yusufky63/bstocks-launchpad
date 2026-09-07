'use client';

import { ArrowUpRight, ChevronDown, ChevronsUpDown, ChevronUp, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { StockTile, TokenLogo } from '@/components/stock/stock-coin';
import { Tabs } from '@/components/ui/controls';
import { AnimatedNumber, PriceChange, TimeAgo } from '@/components/ui/display';
import { Badge, Chip, Empty, PageTitle, Skeleton, StatStrip, cx } from '@/components/ui/primitives';
import { formatCompact, formatNumber, formatRatio, formatUsd } from '@/lib/format';
import { apiGet, useMarkets, useStocks } from '@/lib/queries';
import type { MarketView, MarketsResponse, StocksResponse } from '@/lib/types';

import { PairBadge } from './market-rows';

type SortKey = 'default' | 'price' | 'change24h' | 'volume' | 'fdv' | 'holders';
type Screen = 'all' | 'new' | 'trending' | 'gainers' | 'losers' | 'active';
const SCREENS: Array<{ value: Screen; label: string; hint: string }> = [
  { value: 'all', label: 'All', hint: 'Newest first' },
  { value: 'new', label: 'New', hint: 'Launched in the last 24 hours' },
  { value: 'trending', label: 'Trending', hint: 'Highest 24h volume' },
  { value: 'gainers', label: 'Gainers', hint: 'Best 24h change, traded in the last day' },
  { value: 'losers', label: 'Losers', hint: 'Worst 24h change, traded in the last day' },
  { value: 'active', label: 'Traded 24h', hint: 'At least one swap in the last day' },
];
const DAY_MS = 24 * 60 * 60 * 1000;

function SortHeader({ label, col, sort, onSort }: { label: string; col: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (k: SortKey) => void }) {
  const active = sort.key === col;
  return (
    <button type="button" onClick={() => onSort(col)} className={cx('inline-flex items-center gap-1 justify-end w-full font-mono text-[11px] uppercase tracking-[0.12em] transition-fast', active ? 'text-ink' : 'text-ink-muted hover:text-ink')}>
      {label}
      {active ? sort.dir === 'asc' ? <ChevronUp size={11} strokeWidth={2} /> : <ChevronDown size={11} strokeWidth={2} /> : <ChevronsUpDown size={11} strokeWidth={2} className="opacity-30" />}
    </button>
  );
}

/** The screener rule, shared by the list and the counts so they never disagree. */
export function applyScreen(rows: MarketView[], screen: Screen, now = Date.now()): MarketView[] {
  switch (screen) {
    case 'new':
      return rows.filter((m) => now - new Date(m.launchedAt).getTime() < DAY_MS);
    case 'trending':
      return [...rows].filter((m) => m.trades24h > 0).sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
    case 'gainers':
      return [...rows].filter((m) => m.trades24h > 0 && (m.change24hPercent ?? 0) > 0).sort((a, b) => (b.change24hPercent ?? 0) - (a.change24hPercent ?? 0));
    case 'losers':
      return [...rows].filter((m) => m.trades24h > 0 && (m.change24hPercent ?? 0) < 0).sort((a, b) => (a.change24hPercent ?? 0) - (b.change24hPercent ?? 0));
    case 'active':
      return rows.filter((m) => m.trades24h > 0);
    default:
      return rows;
  }
}

const COLUMNS = 'md:grid-cols-[minmax(0,1fr)_110px_130px_90px_120px_110px_80px_150px]';

export function MarketsView({ initialMarkets, initialStocks, initialStock }: { initialMarkets?: MarketsResponse; initialStocks?: StocksResponse; initialStock?: string }) {
  const [stock, setStock] = useState<string | null>(initialStock ?? null);
  const [screen, setScreen] = useState<Screen>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'default', dir: 'desc' });
  const onSort = (key: SortKey) => setSort((s) => (s.key !== key ? { key, dir: 'desc' } : s.dir === 'desc' ? { key, dir: 'asc' } : { key: 'default', dir: 'desc' }));

  // Markets is the live board: it polls every 5 s so a launch or a swap shows up within one indexer
  // tick, and every 3 s while the New screen is open, whether or not the visitor reloads.
  const markets = useMarkets({ stock: stock ?? undefined, q: query }, !stock && !query ? initialMarkets : undefined, { refetchInterval: screen === 'new' ? 3_000 : 5_000, refetchIntervalInBackground: screen === 'new' });
  const { data: stocksData } = useStocks(initialStocks);
  const stocks = stocksData?.stocks ?? [];

  // The first 100 stay live through the polling query; older pages are fetched once and appended.
  const [extra, setExtra] = useState<MarketView[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const filterKey = `${stock ?? ''}:${query.trim()}`;
  useEffect(() => {
    setExtra([]);
    setExhausted(false);
  }, [filterKey]);
  const live = markets.data?.markets;
  const all = useMemo(() => {
    const head = live ?? [];
    const seen = new Set(head.map((m) => m.token));
    return [...head, ...extra.filter((m) => !seen.has(m.token))];
  }, [live, extra]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const search = new URLSearchParams();
      if (stock) search.set('stock', stock);
      if (query.trim()) search.set('q', query.trim());
      search.set('limit', '100');
      search.set('offset', String(all.length));
      const page = await apiGet<MarketsResponse>(`/api/markets?${search}`);
      setExtra((prev) => [...prev, ...page.markets]);
      if (page.markets.length < 100) setExhausted(true);
    } catch {
      /* button stays; the user can retry */
    }
    setLoadingMore(false);
  };
  const fresh = useMemo(() => applyScreen(all, 'new'), [all]);

  const rows = useMemo(() => {
    const screened = applyScreen(all, screen);
    if (sort.key === 'default') return screened;
    const val = (m: MarketView) =>
      sort.key === 'price' ? m.priceUsd : sort.key === 'change24h' ? m.change24hPercent : sort.key === 'volume' ? m.volume24hUsd : sort.key === 'fdv' ? m.fdvUsd : m.holders;
    return [...screened].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sort.dir === 'asc' ? av - bv : bv - av;
    });
  }, [all, screen, sort]);

  const selectedStock = stocks.find((s) => s.address === stock);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index="02 — Markets"
        title={selectedStock ? `${selectedStock.symbol} pairs` : 'Markets'}
        lead={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span className="live-dot" /> Live · {markets.data ? <>updated <TimeAgo value={markets.data.asOf} placeholder="just now" /></> : 'loading'} · refreshes every {screen === 'new' ? '3' : '5'} s
          </span>
        }
        action={
          <label className="flex items-center h-11 w-full md:w-[320px] rounded-[6px] border border-line-strong bg-canvas px-3 gap-2 focus-within:border-primary transition-fast">
            <Search size={16} strokeWidth={1.75} className="text-ink-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, symbol or address" aria-label="Search tokens" className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-ink-muted" />
          </label>
        }
      />

      <MarketStats rows={all} />

      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mb-1 [scrollbar-width:none]" role="group" aria-label="Filter by paired stock">
        <Chip active={stock === null} onClick={() => setStock(null)} className="h-8 min-h-[32px] px-2.5 text-[12px] shrink-0">
          All stocks
        </Chip>
        {stocks
          .filter((s) => s.launches > 0 || s.address === stock)
          .map((s) => (
            <Chip key={s.address} active={stock === s.address} onClick={() => setStock(stock === s.address ? null : s.address)} className="h-8 min-h-[32px] pl-1.5 pr-2.5 text-[12px] gap-1.5 inline-flex items-center shrink-0">
              <StockTile ticker={s.ticker} size={16} className="rounded-[3px] border-0" />
              {s.symbol} <span className="font-mono text-ink-muted">{s.launches}</span>
            </Chip>
          ))}
      </div>

      <div className="border border-line rounded-[8px] overflow-hidden bg-canvas ticks">
        <div className="overflow-x-auto [scrollbar-width:none]">
          <div className="min-w-[600px]">
            <Tabs<Screen>
              ariaLabel="Screen tokens"
              value={screen}
              onChange={setScreen}
              tabs={SCREENS.map((s) => ({
                id: s.value,
                label:
                  s.value === 'new' && fresh.length > 0 ? (
                    <>
                      New <span className="ml-1 font-mono text-[10px] text-primary">{fresh.length}</span>
                    </>
                  ) : (
                    s.label
                  ),
              }))}
            />
          </div>
        </div>
        <div className={cx('hidden md:grid gap-3 px-4 py-2 border-b border-line font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted whitespace-nowrap items-center', COLUMNS)}>
          <span>Token</span>
          <span>Pair</span>
          <SortHeader label="Price" col="price" sort={sort} onSort={onSort} />
          <SortHeader label="24h" col="change24h" sort={sort} onSort={onSort} />
          <SortHeader label="Volume 24h" col="volume" sort={sort} onSort={onSort} />
          <SortHeader label="FDV" col="fdv" sort={sort} onSort={onSort} />
          <SortHeader label="Holders" col="holders" sort={sort} onSort={onSort} />
          <span />
        </div>
        {markets.isLoading && !markets.data && (
          <div className="p-4 flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}
        {markets.isError && !markets.data && <Empty>Markets are temporarily unavailable. Please try again.</Empty>}
        {rows.map((m) => (
          <MarketRow key={m.token} market={m} isNew={Date.now() - new Date(m.launchedAt).getTime() < 60 * 60 * 1000} />
        ))}
        {markets.data && rows.length === 0 && (
          <Empty>
            {query ? `No tokens match “${query}”.` : screen !== 'all' ? 'No token matches this screen right now.' : stock ? 'No tokens paired with this stock yet.' : 'No tokens yet.'}{' '}
            <Link href="/create" className="text-primary font-medium">
              Create one →
            </Link>
          </Empty>
        )}
        {!exhausted && all.length >= 100 && (
          <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="w-full h-11 border-t border-line text-[13px] font-medium text-primary hover:bg-surface transition-fast disabled:opacity-50">
            {loadingMore ? 'Loading…' : 'Load more tokens'}
          </button>
        )}
      </div>
      <p className="text-[12px] text-ink-muted">
        Price is the last swap in the token's Uniswap v4 pool, converted with the stock's Chainlink price. Off US market hours the feed holds the last close, so USD figures are last-close figures. Every number here is read from the chain; nothing is estimated.
      </p>
    </div>
  );
}

function MarketRow({ market, isNew }: { market: MarketView; isNew: boolean }) {
  const stale = market.stockFeedStatus !== 'live';
  return (
    <div className={cx('rail grid grid-cols-[1fr_auto] items-center px-4 py-3 border-b border-line last:border-b-0 gap-3 hover:bg-surface transition-fast', COLUMNS)}>
      <Link href={`/token/${market.token}`} className="flex items-center gap-3 min-w-0">
        <TokenLogo src={market.imageUrl} symbol={market.symbol} size={36} />
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-medium text-[15px] leading-tight min-w-0">
            <span className="truncate">
              {market.name} <span className="text-ink-muted font-mono text-[11px]">{market.symbol}</span>
            </span>
            {isNew && <Badge tone="primary">new</Badge>}
          </span>
          <span className="block text-[13px] text-ink-secondary truncate">
            launched <TimeAgo value={market.launchedAt} placeholder="…" /> · {formatNumber(market.holders, 0)} holders
          </span>
          <PairBadge market={market} className="mt-1 md:hidden" />
        </span>
      </Link>
      <div className="md:hidden text-right">
        <div className="display num text-[16px]">
          <AnimatedNumber value={market.priceUsd} format={(v) => formatUsd(v)} />
        </div>
        <PriceChange value={market.change24hPercent} className="text-[12px]" />
      </div>
      <div className="hidden md:block">
        <PairBadge market={market} />
      </div>
      <div className="hidden md:block text-right">
        <div className="display num text-[16px]">
          <AnimatedNumber value={market.priceUsd} format={(v) => formatUsd(v)} />
        </div>
        <div className="font-mono text-[10px] text-ink-muted truncate">{market.priceInStock === null ? 'no trades yet' : `${formatRatio(market.priceInStock)} ${market.stock.symbol}${stale ? ' · last close' : ''}`}</div>
      </div>
      <div className="hidden md:block text-right">
        <PriceChange value={market.change24hPercent} />
      </div>
      <div className="hidden md:block text-right font-mono num text-[12px]">
        <span className="block">{market.volume24hStock > 0 ? formatUsd(market.volume24hUsd, { compact: true }) : '—'}</span>
        <span className="block text-ink-muted">{market.trades24h > 0 ? `${market.trades24h} trade${market.trades24h === 1 ? '' : 's'}` : 'no trades 24h'}</span>
      </div>
      <div className="hidden md:block text-right font-mono num text-[13px]">{formatUsd(market.fdvUsd, { compact: true })}</div>
      <div className="hidden md:block text-right font-mono num text-[13px]">{formatCompact(market.holders)}</div>
      <div className="hidden md:flex items-center justify-end gap-1.5">
        <Link href={`/token/${market.token}?trade=buy`} className="inline-flex items-center justify-center gap-1 h-9 min-w-[88px] px-3 rounded-[6px] text-[13px] font-medium bg-primary text-primary-contrast hover:bg-primary-strong transition-fast">
          Buy <ArrowUpRight size={14} strokeWidth={1.75} />
        </Link>
      </div>
    </div>
  );
}

/** Totals across the listed markets, computed from the rows the page already holds. */
export function MarketStats({ rows }: { rows: MarketView[] }) {
  const volume = rows.reduce((sum, m) => sum + (m.volume24hUsd ?? 0), 0);
  const trades = rows.reduce((sum, m) => sum + m.trades24h, 0);
  const priced = rows.filter((m) => m.change24hPercent !== null);
  const up = priced.filter((m) => (m.change24hPercent ?? 0) > 0).length;
  const fdv = rows.reduce((sum, m) => sum + (m.fdvUsd ?? 0), 0);
  return (
    <StatStrip
      cells={[
        { label: 'Tokens', value: String(rows.length) },
        { label: 'Volume · 24h', value: volume > 0 ? formatUsd(volume, { compact: true }) : '—' },
        { label: 'Trades · 24h', value: trades > 0 ? formatNumber(trades, 0) : '—' },
        { label: 'Up today', value: priced.length ? `${up} / ${priced.length}` : fdv > 0 ? formatUsd(fdv, { compact: true }) : '—' },
      ]}
    />
  );
}
