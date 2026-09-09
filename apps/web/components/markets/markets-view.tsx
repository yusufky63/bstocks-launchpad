'use client';

import { ArrowUpRight, ChevronDown, ChevronsUpDown, ChevronUp, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { StockTile, TokenLogo } from '@/components/stock/stock-coin';
import { Tabs } from '@/components/ui/controls';
import { AnimatedNumber, PriceChange, TimeAgo } from '@/components/ui/display';
import { Badge, Chip, Empty, PageTitle, Skeleton, StatStrip, cx } from '@/components/ui/primitives';
import { formatCompact, formatNumber, formatRatio, formatUsd } from '@/lib/format';
import { motionEnabled } from '@/lib/motion';
import { apiGet, useMarkets, useStocks } from '@/lib/queries';
import type { MarketView, MarketsResponse, StocksResponse } from '@/lib/types';

import { SCREENS, applyScreen, type Screen } from '@/lib/screens';

import { PairBadge } from './market-rows';

type SortKey = 'default' | 'price' | 'change24h' | 'volume' | 'fdv' | 'holders';

function SortHeader({ label, col, sort, onSort }: { label: string; col: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (k: SortKey) => void }) {
  const active = sort.key === col;
  return (
    <button type="button" onClick={() => onSort(col)} className={cx('inline-flex items-center gap-1 justify-end w-full font-mono text-[11px] uppercase tracking-[0.12em] transition-fast', active ? 'text-ink' : 'text-ink-muted hover:text-ink')}>
      {label}
      {active ? sort.dir === 'asc' ? <ChevronUp size={11} strokeWidth={2} /> : <ChevronDown size={11} strokeWidth={2} /> : <ChevronsUpDown size={11} strokeWidth={2} className="opacity-30" />}
    </button>
  );
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

  // Two minutes is many indexer ticks; past that the data has stopped moving for a real reason.
  const asOf = markets.data?.asOf;
  const stale = Boolean(asOf && Date.now() - new Date(asOf).getTime() > 2 * 60_000);

  const selectedStock = stocks.find((s) => s.address === stock);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index="02 — Markets"
        title={selectedStock ? `${selectedStock.symbol} pairs` : 'Markets'}
        lead={
          <span className="inline-flex items-center gap-2 flex-wrap">
            {/* asOf is the indexer's last write. If that stops advancing the board is not live, however
                often this page polls, so the dot and the word go away rather than reassuring falsely. */}
            {stale ? (
              <>
                <span className="text-warning-fg">Not updating</span> · last indexed <TimeAgo value={markets.data!.asOf} placeholder="just now" />
              </>
            ) : (
              <>
                <span className="live-dot" /> Live · {markets.data ? <>updated <TimeAgo value={markets.data.asOf} placeholder="just now" /></> : 'loading'} · refreshes every {screen === 'new' ? '3' : '5'} s
              </>
            )}
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

/**
 * Briefly marks a row when a trade lands on it, so a board that refreshes in the background reads as
 * live. The direction comes from the price move, so a sell is not dressed up in green. Nothing
 * flashes on the first render, or when the visitor has asked for reduced motion.
 */
function useTradeFlash(lastTradeAt: string | null, priceUsd: number | null): 'buy' | 'sell' | null {
  const seen = useRef<{ at: string | null; price: number | null } | null>(null);
  const [flash, setFlash] = useState<'buy' | 'sell' | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { at: lastTradeAt, price: priceUsd };
    if (!before || !lastTradeAt || before.at === lastTradeAt || !motionEnabled()) return;
    setFlash(before.price !== null && priceUsd !== null && priceUsd < before.price ? 'sell' : 'buy');
    const clear = setTimeout(() => setFlash(null), 1_400);
    return () => clearTimeout(clear);
  }, [lastTradeAt, priceUsd]);
  return flash;
}

function MarketRow({ market, isNew }: { market: MarketView; isNew: boolean }) {
  const stale = market.stockFeedStatus !== 'live';
  const flash = useTradeFlash(market.lastTradeAt, market.priceUsd);
  return (
    <div
      className={cx(
        'rail grid grid-cols-[1fr_auto] items-center px-4 py-3 border-b border-line last:border-b-0 gap-3 hover:bg-surface transition-fast',
        COLUMNS,
        flash && `trade-flash trade-flash-${flash}`,
      )}
    >
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
/**
 * Totals for whatever the board is currently showing, so they still describe the set after a stock
 * filter. Each figure is given for the last day and since launch: the day says whether the board is
 * busy now, and the lifetime figure is what says how much has happened here at all.
 */
export function MarketStats({ rows }: { rows: MarketView[] }) {
  const volume24h = rows.reduce((sum, m) => sum + (m.volume24hUsd ?? 0), 0);
  const trades24h = rows.reduce((sum, m) => sum + m.trades24h, 0);
  const volume = rows.reduce((sum, m) => sum + (m.volumeUsd ?? 0), 0);
  const trades = rows.reduce((sum, m) => sum + m.trades, 0);
  const holders = rows.reduce((sum, m) => sum + m.holders, 0);
  return (
    <StatStrip
      columns="grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
      cells={[
        { label: 'Tokens', value: String(rows.length) },
        { label: 'Volume · 24h', value: volume24h > 0 ? formatUsd(volume24h, { compact: true }) : '—' },
        { label: 'Volume · all', value: volume > 0 ? formatUsd(volume, { compact: true }) : '—' },
        { label: 'Trades · 24h', value: trades24h > 0 ? formatNumber(trades24h, 0) : '—' },
        { label: 'Trades · all', value: trades > 0 ? formatNumber(trades, 0) : '—' },
        { label: 'Holders', value: holders > 0 ? formatNumber(holders, 0) : '—' },
      ]}
    />
  );
}
