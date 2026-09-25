'use client';

import { safeExternalUrl } from '@/lib/profile';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { XMark } from '@/components/brand/logo';
import { PairBadge } from '@/components/markets/market-rows';
import { TokenLogo } from '@/components/stock/stock-coin';
import { TradePanel } from '@/components/trade/trade-panel';
import { AddressLabel, AnimatedNumber, Banner, PriceChange, TimeAgo, TxLink, Named } from '@/components/ui/display';
import { Badge, Button, KeyValue, Module, Skeleton, StatStrip, cx } from '@/components/ui/primitives';
import { Sheet, StickyPanel } from '@/components/ui/sheet';
import { bpsToPct, formatDateTime, formatNumber, formatPct, formatRatio, formatUsd, shortAddress } from '@/lib/format';
import { devBuyTier } from '@/lib/launch';
import { qk, useSwaps, useToken } from '@/lib/queries';
import { useIsDesktop } from '@/lib/settings';
import { telegramHandle } from '@/lib/profile';
import { twitterHandle } from '@/lib/twitter';
import type { LaunchInfo, MarketView, TokenResponse } from '@/lib/types';

import { ChartModule } from './chart-module';
import { EditProfile } from './edit-profile';
import { OnchainProfile } from './onchain-profile';
import { TokenRecords } from './token-records';

/**
 * Token detail. Desktop: chart + records on the left, the trade panel sticky on the right.
 * Mobile: chart first, a fixed Buy / Sell bar at the bottom opening the trade sheet.
 */
export function TokenView({ address, initialData }: { address: string; initialData: TokenResponse }) {
  const { data } = useToken(address, initialData);
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const isDesktop = useIsDesktop();
  const tradeParam = search.get('trade');
  const [side, setSide] = useState<'buy' | 'sell'>(tradeParam === 'sell' ? 'sell' : 'buy');
  const [mobileTrade, setMobileTrade] = useState(Boolean(tradeParam));
  const [seenParam, setSeenParam] = useState(tradeParam);
  if (tradeParam !== seenParam) {
    setSeenParam(tradeParam);
    if (tradeParam === 'buy' || tradeParam === 'sell') {
      setSide(tradeParam);
      setMobileTrade(true);
    }
  }
  const view = data ?? initialData;
  const swaps = useSwaps(address, view.status === 'indexed');

  if (view.status === 'pending') {
    return (
      <Module ticks className="p-6 md:p-10 flex flex-col gap-4 items-start">
        <div className="eyebrow">
          <span className="live-dot" /> Launch submitted · waiting for Base
        </div>
        <h1 className="display text-[32px] md:text-[40px] leading-none">Your token is on its way.</h1>
        <p className="text-ink-secondary max-w-[60ch]">
          The launch transaction is in flight. This page turns into the token page by itself the moment the block lands and the indexer records it, usually within ten to twenty seconds.
        </p>
        <AddressLabel address={view.token} explorer kind="token" chars={10} />
        {view.txHash && <TxLink hash={view.txHash}>Launch transaction</TxLink>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </Module>
    );
  }

  if (view.status === 'indexing') {
    const l = view.launch;
    return (
      <Module ticks className="p-6 md:p-10 flex flex-col gap-4 items-start">
        <div className="eyebrow">
          <span className="live-dot" /> Confirmed onchain · indexing
        </div>
        <h1 className="display text-[32px] md:text-[40px] leading-none">
          {l.name} <span className="text-ink-muted font-mono text-[14px] tracking-normal font-normal">{l.symbol}</span>
        </h1>
        <p className="text-ink-secondary max-w-[60ch]">
          Created {formatDateTime(l.launchedAt)} against {l.stockSymbol ?? shortAddress(l.stock)}. Trades, holders and the chart appear as soon as the indexer records the block, usually within a few seconds. This page refreshes itself.
        </p>
        <AddressLabel address={l.token} explorer kind="token" chars={10} />
        <Banner tone="info">The indexer waits for three block confirmations before recording a launch, so a reorg can never show a token that does not exist.</Banner>
      </Module>
    );
  }

  const market = view.market;
  const details = view.details;
  const { launch, profile } = view;
  const creatorSwaps = (swaps.data?.swaps ?? []).filter((s) => s.isCreator);
  const closeMobileTrade = () => {
    setMobileTrade(false);
    if (search.get('trade')) router.replace(`/token/${market.token}`);
  };
  const onTraded = () => {
    void qc.invalidateQueries({ queryKey: qk.token(market.token) });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Module ticks>
            <div className="p-4 md:p-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <TokenLogo src={market.imageUrl} symbol={market.symbol} size={64} />
                <div className="min-w-0">
                  <div className="eyebrow mb-1">
                    {market.symbol} · paired with {market.stock.symbol}
                  </div>
                  <h1 className="display text-[26px] md:text-[32px] leading-tight truncate">
                    {market.name} <span className="text-ink-muted font-mono text-[13px] tracking-normal font-normal">{market.symbol}</span>
                  </h1>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <PairBadge market={market} />
                    <Badge title={formatDateTime(market.launchedAt)}>
                      launched <TimeAgo value={market.launchedAt} placeholder="…" />
                    </Badge>
                    <Link href={`/wallet/${market.creator}`} className="inline-flex">
                      <Badge tone="primary" className="hover:bg-primary/15 transition-fast">creator <Named address={market.creator} /></Badge>
                    </Link>
                    <DevBuyChip launch={launch} market={market} />
                    {/* No badge for fixed profiles: their signed off-chain profile still applies. */}
                    {profile?.onchain === 'editable' && <Badge tone="warning" title="The creator can still replace the image, description and links onchain.">Editable profile</Badge>}
                    {profile?.onchain === 'locked' && <Badge title="The creator gave up editing for good.">Profile locked</Badge>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                {/* Guarded again here: rows indexed before the URL check above can still hold junk. */}
                {/* `URL.canParse` says nothing about the scheme: `javascript:` parses. */}
                {safeExternalUrl(market.website) && <IconLink href={safeExternalUrl(market.website)!} label={new URL(safeExternalUrl(market.website)!).hostname} icon={<Globe size={14} strokeWidth={1.75} />} />}
                {safeExternalUrl(market.twitter) && <IconLink href={safeExternalUrl(market.twitter)!} label={twitterHandle(market.twitter!)} icon={<XMark />} />}
                {safeExternalUrl(market.telegram) && <IconLink href={safeExternalUrl(market.telegram)!} label={telegramHandle(market.telegram!)} icon={<Send size={13} strokeWidth={1.75} />} />}
                {/* One editing path per token: signed off-chain for fixed profiles, onchain for editable ones. */}
                {(!profile || profile.onchain === 'immutable') && <EditProfile key={market.profileUpdatedAt ?? 'launch'} market={market} />}
                {profile?.onchain === 'editable' && launch?.factory && <OnchainProfile key={profile.contractUri} market={market} factory={launch.factory} contentAddressed={profile.contentAddressed} />}
              </div>
            </div>
            <div className="px-4 md:px-5 pb-4 flex items-baseline gap-3 flex-wrap">
              <span className="display num text-[44px] md:text-[60px] leading-none">
                <AnimatedNumber value={market.priceUsd} format={(v) => formatUsd(v)} />
              </span>
              <PriceChange value={market.change24hPercent} className="text-[16px]" />
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
                {market.priceInStock === null ? 'no trades yet' : `${formatRatio(market.priceInStock)} ${market.stock.symbol} · ${market.stockFeedStatus === 'live' ? 'feed live' : 'last close'}`}
                {market.lastTradeAt && (
                  <>
                    {' '}· last trade <TimeAgo value={market.lastTradeAt} />
                  </>
                )}
              </span>
            </div>
            <StatStrip
              columns="grid-cols-2 md:grid-cols-4"
              className="rounded-none border-x-0 border-b-0"
              cells={[
                { label: 'FDV', value: formatUsd(market.fdvUsd, { compact: true }) },
                { label: 'Liquidity', value: details?.pool ? formatUsd(details.pool.stockReserveUsd, { compact: true }) : '—' },
                { label: 'Volume · 24h', value: market.volume24hStock > 0 ? formatUsd(market.volume24hUsd, { compact: true }) : '—' },
                { label: 'Volume · all', value: details ? formatUsd(details.lifetime.volumeUsd, { compact: true }) : '—' },
              ]}
            />
            <div className="border-t border-line">
              <ChartModule token={market.token} poolId={market.poolId} stockSymbol={market.stock.symbol} creatorSwaps={creatorSwaps} />
            </div>
          </Module>

          <Module>
            <TokenRecords market={market} launch={launch} profile={profile} links={details?.links} trades={details?.lifetime.trades} fees={<FeesPanel details={details} market={market} />} />
          </Module>
        </div>

        {isDesktop && (
          <StickyPanel>
            <Module ticks>
              <TradePanel market={market} initialSide={side} onTraded={onTraded} />
            </Module>
          </StickyPanel>
        )}
      </div>

      {!isDesktop && (
        <>
          <div className="fixed inset-x-0 bottom-14 z-20 border-t border-line bg-canvas px-4 py-2 grid grid-cols-2 gap-2 [padding-bottom:calc(8px+env(safe-area-inset-bottom))]">
            <Button
              size="lg"
              onClick={() => {
                setSide('buy');
                setMobileTrade(true);
              }}
            >
              Buy
            </Button>
            <Button
              size="lg"
              variant="ink"
              onClick={() => {
                setSide('sell');
                setMobileTrade(true);
              }}
            >
              Sell
            </Button>
          </div>
          <Sheet open={mobileTrade} onClose={closeMobileTrade} title={market.symbol} wide>
            <div className="-mx-5 -my-4">
              <TradePanel market={market} initialSide={side} onTraded={onTraded} />
            </div>
          </Sheet>
        </>
      )}
    </div>
  );
}

/** "Dev buy P%": neutral below 5%, amber from 5%, red from 15%. Absent when the creator bought nothing at launch. */
function DevBuyChip({ launch, market }: { launch: LaunchInfo | undefined; market: MarketView }) {
  const buy = launch?.creatorBuy;
  if (!buy) return null;
  const pct = (Number(BigInt(buy.tokensOutRaw)) / 1e27) * 100;
  const tier = devBuyTier(buy.supplyBps);
  const stockAmount = Number(buy.stockInRaw) / 10 ** market.stock.decimals;
  return (
    <Badge
      tone={tier === 'none' ? 'neutral' : tier === 'notice' ? 'warning' : 'danger'}
      title={`The creator bought ${pct.toFixed(2)}% of supply in the launch transaction for ${formatNumber(stockAmount, 6)} ${market.stock.symbol}. Nobody could trade before them.`}
    >
      Dev buy {pct.toFixed(2)}%
    </Badge>
  );
}

function IconLink({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={label} aria-label={label} className="inline-flex items-center justify-center h-8 w-8 rounded-[6px] border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
      {icon}
    </a>
  );
}

/** Fees, pool reserves and the creator's own trading, side by side with the trade panel. */
/** Fees, pool reserves and the creator's own trading; rendered inside the records tabs. */
function FeesPanel({ details, market }: { details: NonNullable<Extract<TokenResponse, { status: 'indexed' }>['details']> | undefined; market: Extract<TokenResponse, { status: 'indexed' }>['market'] }) {
  if (!details) {
    return (
      <div className="p-4">
        <Skeleton className="h-24" />
      </div>
    );
  }
  const { fees, pool } = details;
  const stale = market.stockFeedStatus !== 'live';
  return (
    <div>
      {pool && <p className="px-4 py-2 border-b border-line font-mono text-[11px] text-ink-muted">swap fee right now {bpsToPct(pool.feeBps)} · paid in {market.stock.symbol} · 70% creator / 30% platform</p>}
      <div className="module-grid grid-cols-2 md:grid-cols-4 rounded-none border-0 border-b border-line">
        <div className="p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Fees paid · all time</div>
          <div className="display num text-[20px] leading-tight">{formatUsd(fees.totalUsd)}</div>
          <div className="font-mono text-[11px] text-ink-secondary">
            {formatNumber(fees.totalStock, 6)} {market.stock.symbol} · {fees.events} swaps
          </div>
        </div>
        <div className="p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Creator earned · 70%</div>
          <div className="display num text-[20px] leading-tight text-positive-fg">{formatUsd(fees.creatorUsd)}</div>
          <div className="font-mono text-[11px] text-ink-secondary">{formatNumber(fees.creatorStock, 6)} {market.stock.symbol}</div>
        </div>
        <div className="p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Platform · 30%</div>
          <div className="display num text-[20px] leading-tight">{formatUsd(fees.platformUsd)}</div>
          <div className="font-mono text-[11px] text-ink-secondary">{formatNumber(fees.platformStock, 6)} {market.stock.symbol}</div>
        </div>
        <div className="p-3">
          {/* Read from this token's own hook, which books claims per (stock, creator), not per token:
              it covers every token this creator paired to this stock through the same contracts, and
              one claim there withdraws them together. Tokens on another deployment's hook are counted
              there, and on the wallet page. Labelled for exactly that. */}
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted" title={`Fees the creator can withdraw in ${market.stock.symbol} from this token's hook. It includes their other ${market.stock.symbol} tokens on the same hook; the wallet page adds up every hook.`}>
            Creator claimable · {market.stock.symbol} on this hook
          </div>
          <div className="display num text-[20px] leading-tight">{fees.claimableUsd === null ? '—' : formatUsd(fees.claimableUsd)}</div>
          <div className="font-mono text-[11px] text-ink-secondary">{fees.claimableStock === null ? '—' : `${formatNumber(fees.claimableStock, 6)} ${market.stock.symbol}`}</div>
        </div>
      </div>
      {pool ? (
        <div className="px-4 py-2">
          <KeyValue k={`${market.stock.symbol} in pool`} v={`${formatNumber(pool.stockReserve, 6)} · ${formatUsd(pool.stockReserveUsd)}${stale ? ' (last close)' : ''}`} />
          <KeyValue k={`${market.symbol} in pool`} v={`${formatNumber(pool.tokenReserve, 0)} · ${formatPct(pool.tokenShareOfSupply * 100, { sign: false, digits: 2 })} of supply`} />
          <KeyValue k="Liquidity" v="100% of supply, locked forever in the v4 position" mono={false} />
        </div>
      ) : (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">Pool reserves load once the pool state is read from the chain.</p>
      )}
      <p className="px-4 py-2.5 border-t border-line text-[11px] text-ink-muted">Fees are held by the hook as claims in the stock and withdrawn by the creator from their wallet page. Pool reserves are computed from the locked position and the live pool price.</p>
    </div>
  );
}
