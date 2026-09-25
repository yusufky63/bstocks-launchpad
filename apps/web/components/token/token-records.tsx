'use client';

import { safeExternalUrl } from '@/lib/profile';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

import { Tabs } from '@/components/ui/controls';
import { AddressLabel, Named, TimeAgo, TxLink } from '@/components/ui/display';
import { Empty, KeyValue, Skeleton, cx } from '@/components/ui/primitives';
import { formatDateTime, formatNumber, formatPct, formatRatio, formatUsd, shortAddress } from '@/lib/format';
import { apiGet, useHolders, useSwaps } from '@/lib/queries';
import type { LaunchInfo, MarketView, ProfileInfo, SwapView, SwapsResponse, TokenDetails } from '@/lib/types';
import { ExternalLink } from 'lucide-react';

type Tab = 'trades' | 'holders' | 'fees' | 'details';

/** Page controls shared by the trades and holders tabs: a position readout and two steps. */
function Pager({ page, from, to, total, busy, hasNext, onPrev, onNext, labels = ['Previous', 'Next'] }: { page: number; from: number; to: number; total?: number; busy: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; labels?: [string, string] }) {
  if (page === 0 && !hasNext) return null;
  const step = 'h-8 px-3 rounded-[6px] border border-line text-[12px] font-medium transition-fast disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:border-line-strong enabled:hover:text-ink text-ink-secondary';
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line">
      <span className="font-mono text-[11px] text-ink-muted">
        {busy ? 'Loading…' : `${from}–${to}${total ? ` of ${formatNumber(total, 0)}` : ''}`}
      </span>
      <span className="flex items-center gap-2">
        <button type="button" className={step} disabled={page === 0 || busy} onClick={onPrev}>
          {labels[0]}
        </button>
        <button type="button" className={step} disabled={!hasNext || busy} onClick={onNext}>
          {labels[1]}
        </button>
      </span>
    </div>
  );
}

/** A small marker for a trade made by the token's creator. */
function DevTag() {
  return (
    <span title="Made by the token creator" className="text-[9px] font-mono uppercase tracking-[0.08em] px-1 leading-[14px] rounded-[3px] bg-warning-soft text-warning-fg">
      dev
    </span>
  );
}

/** Rows shown per page in the trades and holders tabs. */
const PER_PAGE = 25;
/** Rows pulled from the API in one request; a fetch covers several pages of scrolling. */
const FETCH = 100;
const HOLDERS_MAX = 500;

const TABS: readonly Tab[] = ['trades', 'holders', 'fees', 'details'];

function tabFrom(value: string | null): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'trades';
}

export function TokenRecords({ market, launch, profile, links, fees, trades }: { market: MarketView; launch?: LaunchInfo; profile?: ProfileInfo; links?: TokenDetails['links']; fees?: ReactNode; trades?: number }) {
  // `?tab=holders` opens the holders list directly, so a link can point at it. Without this the
  // Telegram channel's Holders button and its Trade button landed on the same view.
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => tabFrom(search.get('tab')));
  const swaps = useSwaps(market.token, tab === 'trades');
  const [holdersLimit, setHoldersLimit] = useState(FETCH);
  const holders = useHolders(market.token, tab === 'holders', holdersLimit);

  // The newest page stays live (the query refetches); older pages are fetched once and appended.
  const [older, setOlder] = useState<SwapView[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [tradePage, setTradePage] = useState(0);
  const [holderPage, setHolderPage] = useState(0);
  const latest = swaps.data?.swaps;
  const allSwaps = useMemo(() => {
    const head = latest ?? [];
    const seen = new Set(head.map((s) => `${s.txHash}:${s.logIndex}`));
    return [...head, ...older.filter((s) => !seen.has(`${s.txHash}:${s.logIndex}`))];
  }, [latest, older]);

  const fetchOlder = async (): Promise<number> => {
    const last = allSwaps[allSwaps.length - 1];
    if (!last) return 0;
    setLoadingMore(true);
    try {
      const page = await apiGet<SwapsResponse>(`/api/tokens/${market.token}/swaps?limit=${FETCH}&before=${last.blockNumber}&beforeLog=${last.logIndex}`);
      setOlder((prev) => [...prev, ...page.swaps]);
      if (page.swaps.length < FETCH) setExhausted(true);
      return page.swaps.length;
    } catch {
      return 0;
    } finally {
      setLoadingMore(false);
    }
  };

  // Paging past what is loaded pulls the next batch first, so the reader never sees a short page.
  const nextTradePage = async () => {
    if (loadingMore) return;
    const needed = (tradePage + 2) * PER_PAGE;
    if (allSwaps.length < needed && !exhausted) {
      const got = await fetchOlder();
      if (got === 0 && allSwaps.length <= (tradePage + 1) * PER_PAGE) return;
    }
    setTradePage((p) => p + 1);
  };

  const tradeRows = allSwaps.slice(tradePage * PER_PAGE, (tradePage + 1) * PER_PAGE);
  const moreTrades = allSwaps.length > (tradePage + 1) * PER_PAGE || !exhausted;
  const loadedHolders = holders.data?.holders ?? [];
  const holderRows = loadedHolders.slice(holderPage * PER_PAGE, (holderPage + 1) * PER_PAGE);
  // We hold `holdersLimit` rows; more exist if the fetch came back full and we have not raised the cap.
  const loadedHoldersCapped = loadedHolders.length >= holdersLimit && holdersLimit < HOLDERS_MAX;

  return (
    <>
      <Tabs<Tab>
        ariaLabel="Token records"
        value={tab}
        onChange={(next) => {
          setTab(next);
          // replaceState rather than the router: this is a view change, not navigation, and the
          // router would re-render the page and drop the pages already fetched.
          const url = new URL(window.location.href);
          if (next === 'trades') url.searchParams.delete('tab');
          else url.searchParams.set('tab', next);
          window.history.replaceState(null, '', url);
        }}
        tabs={[
          { id: 'trades', label: trades === undefined ? 'Trades' : `Trades · ${formatNumber(trades, 0)}` },
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
        ) : allSwaps.length === 0 ? (
          <Empty>No trades yet. The first swap shows up here within a few blocks.</Empty>
        ) : (
          <div>
            {allSwaps.some((s) => s.isCreator) && (
              <p className="px-4 py-2 border-b border-line font-mono text-[11px] text-warning-fg">
                {allSwaps.filter((s) => s.isCreator).length} dev {allSwaps.filter((s) => s.isCreator).length === 1 ? 'trade' : 'trades'} by the creator, of the {allSwaps.length} loaded
              </p>
            )}
            {tradeRows.map((s) => (
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
                        {s.isCreator ? 'creator' : <Named address={s.trader} />}
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
            <Pager
              page={tradePage}
              from={tradePage * PER_PAGE + 1}
              to={tradePage * PER_PAGE + tradeRows.length}
              total={trades}
              busy={loadingMore}
              hasNext={moreTrades}
              onPrev={() => setTradePage((p) => Math.max(0, p - 1))}
              onNext={() => void nextTradePage()}
              labels={['Newer', 'Older']}
            />
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
            {holderRows.map((h) => (
              <div key={h.address} className="rail flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                <span className="font-mono num text-[12px] text-ink-muted w-6 shrink-0 text-right">{h.rank}</span>
                <span className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                  <Link href={`/wallet/${h.address}`} className="font-mono text-[12px] hover:text-primary truncate">
                    <Named address={h.address} chars={6} />
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
            <Pager
              page={holderPage}
              from={holderPage * PER_PAGE + 1}
              to={holderPage * PER_PAGE + holderRows.length}
              total={market.holders}
              busy={holders.isFetching}
              hasNext={(holders.data?.holders.length ?? 0) > (holderPage + 1) * PER_PAGE || loadedHoldersCapped}
              onPrev={() => setHolderPage((p) => Math.max(0, p - 1))}
              onNext={() => {
                // Near the end of what was fetched, widen the request before stepping on.
                if (loadedHoldersCapped) setHoldersLimit(HOLDERS_MAX);
                setHolderPage((p) => p + 1);
              }}
            />
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
          {/* Creator-supplied, so the scheme is checked here as well as on the way in. */}
          <KeyValue k="Website" v={<ExternalValue url={market.website} />} mono={false} />
          <KeyValue k="X" v={<ExternalValue url={market.twitter} />} mono={false} />
          <KeyValue k="Telegram" v={<ExternalValue url={market.telegram} />} mono={false} />
          <KeyValue k="Profile" v={profileText(market, profile)} mono={false} />
          {profile && profile.onchain !== 'immutable' && (
            <KeyValue k="Profile permission" v="The launch factory holds this token's metadata role and uses it only to replace the contract URI when the original creator asks. Name, symbol and supply can never change." mono={false} />
          )}
          <KeyValue k="Token" v={<AddressLabel address={market.token} explorer kind="token" chars={8} />} />
          <KeyValue k="Creator" v={<Link href={`/wallet/${market.creator}`} className="text-primary font-mono">{shortAddress(market.creator, 8)}</Link>} />
          <KeyValue k="Paired stock" v={<span className="inline-flex items-center gap-2">{market.stock.symbol} <AddressLabel address={market.stock.address} explorer kind="token" showCopy={false} /></span>} />
          <KeyValue k="Pool id" v={<AddressLabel address={market.poolId} chars={10} />} />
          <KeyValue k="Launch tx" v={<TxLink hash={market.txHash}>{shortAddress(market.txHash, 8)}</TxLink>} />
          <KeyValue k="Creator buy at launch" v={<CreatorBuyValue launch={launch} market={market} />} mono={false} />
          <KeyValue k="Launched" v={formatDateTime(market.launchedAt)} />
          <KeyValue k="Supply" v="1,000,000,000 · 18 decimals · no admin, no mint, no pause" mono={false} />
          <KeyValue k="Liquidity" v="Whole supply in a single-sided Uniswap v4 position held by the factory. No function can withdraw it." mono={false} />
          <KeyValue k="Fees" v={`1% of every swap in ${market.stock.symbol}: 70% to the creator, 30% to the platform.`} mono={false} />
          <KeyValue k="Opening" v={`Priced from the Chainlink ${market.stock.ticker} feed so the token opened at a $5,000 valuation. Now ${formatRatio(market.priceInStock, market.stock.symbol)} per token.`} mono={false} />
        </div>
      )}
    </>
  );
}

/** What the Profile row says, by where the profile stands onchain. */
export function profileText(market: Pick<MarketView, 'profileUpdatedAt'>, profile: ProfileInfo | undefined): string {
  let text: string;
  if (!profile || profile.onchain === 'immutable') {
    text = market.profileUpdatedAt ? `Updated by the creator with a signed message · ${formatDateTime(market.profileUpdatedAt)}` : 'As written in the launch metadata';
  } else if (profile.onchain === 'locked') {
    const on = `Locked by the creator on ${profile.lockedAt ? formatDateTime(profile.lockedAt) : 'an unknown date'}.`;
    // "Never change" holds only when everything shown is content-addressed; otherwise only the link is fixed.
    text = profile.contentAddressed ? `${on} It can never change again.` : `${on} The token can never point at a different profile again.`;
  } else {
    text =
      profile.updates === 0
        ? 'Editable onchain by the creator · not changed yet'
        : `Editable onchain by the creator · changed ${profile.updates} ${profile.updates === 1 ? 'time' : 'times'}, last ${profile.lastUpdatedAt ? formatDateTime(profile.lastUpdatedAt) : '—'}`;
  }
  // Content behind an https URI, or an ipfs:// path that can leave its CID, can change with no onchain
  // event at all, whatever the status says.
  if (profile && !profile.contentAddressed) text += ' Part of this profile is served from an address whose content can change without an onchain record.';
  return text;
}

/** "N SYM (P%) for X STOCK · tx", or "None". */
function CreatorBuyValue({ launch, market }: { launch: LaunchInfo | undefined; market: MarketView }) {
  const buy = launch?.creatorBuy;
  if (!buy) return <>None</>;
  const tokens = Number(BigInt(buy.tokensOutRaw)) / 1e18;
  const stockAmount = Number(buy.stockInRaw) / 10 ** market.stock.decimals;
  return (
    <span>
      {formatNumber(tokens, 0)} {market.symbol} ({formatPct((tokens / 1e9) * 100, { sign: false })}) for {formatNumber(stockAmount, 6)} {market.stock.symbol} ·{' '}
      <TxLink hash={buy.txHash} className="text-[13px]">
        tx
      </TxLink>
    </span>
  );
}

/** A creator-supplied link, or nothing. Never an anchor to a scheme this page did not choose. */
function ExternalValue({ url }: { url: string | null }) {
  const safe = safeExternalUrl(url);
  if (!safe) return <>{'\u2014'}</>;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" className="text-primary">
      {safe}
    </a>
  );
}
