import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarketDetailRow } from '@/components/markets/market-rows';
import { TokenLogo } from '@/components/stock/stock-coin';
import { AddressLabel, Named, TimeAgo, TxLink } from '@/components/ui/display';
import { Badge, Empty, KeyValue, LinkButton, Module, ModuleHeader, PageTitle, StatStrip } from '@/components/ui/primitives';
import { ClaimFees } from '@/components/wallet/claim-fees';
import { parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { formatDateTime, formatNumber, formatUsd, shortAddress } from '@/lib/format';
import { readWalletSummary } from '@/lib/wallet.server';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: `Wallet ${shortAddress(address)}` };
}

/** One page for a wallet and for a creator: what they made, what they hold, what they earned. */
export default async function WalletPage({ params }: Props) {
  const { address } = await params;
  const wallet = parseAddressParam(address);
  if (!wallet) notFound();
  const summary = await readWalletSummary(await getDb(), wallet);
  // A read that ran out of time renders the shell with the address, not a wallet full of zeros.
  if (!summary) {
    return (
      <div className="flex flex-col gap-5">
        <PageTitle
          index="05 — Wallet"
          title={<span className="font-mono tracking-normal text-[28px] md:text-[36px]"><Named address={wallet} chars={6} /></span>}
          lead="Reading this wallet from confirmed Base events…"
          action={
            <LinkButton href={`https://basescan.org/address/${wallet}`} external>
              BaseScan ↗
            </LinkButton>
          }
        />
        <Empty>This wallet took too long to read. Reload in a moment.</Empty>
      </div>
    );
  }
  const isCreator = summary.creator.tokens > 0;

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index={isCreator ? '05 — Creator profile' : '05 — Wallet'}
        title={<span className="font-mono tracking-normal text-[28px] md:text-[36px]"><Named address={wallet} chars={6} /></span>}
        lead={
          <span className="flex items-center gap-3 flex-wrap">
            <AddressLabel address={wallet} explorer chars={12} />
            {isCreator && <Badge tone="primary">creator since {summary.creator.firstLaunchAt ? formatDateTime(summary.creator.firstLaunchAt).slice(0, 6) : '—'}</Badge>}
          </span>
        }
        action={
          <LinkButton href={`https://basescan.org/address/${wallet}`} external>
            BaseScan ↗
          </LinkButton>
        }
      />

      <StatStrip
        columns="grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
        cells={[
          { label: 'Holdings value', value: formatUsd(summary.holdingsUsd) },
          { label: 'Tokens created', value: String(summary.creator.tokens) },
          { label: 'Created FDV', value: formatUsd(summary.createdFdvUsd, { compact: true }) },
          { label: 'Volume attracted', value: formatUsd(summary.creator.volumeUsd, { compact: true }) },
          { label: 'Fees earned', value: formatUsd(summary.creator.feesEarnedUsd) },
          { label: 'Claimable now', value: formatUsd(summary.claimableUsd) },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Module ticks>
            <ModuleHeader index="01" title={`Created tokens · ${summary.created.length}`} action={<Link href="/create" className="text-[13px] text-primary font-medium">Create →</Link>} />
            {summary.created.length === 0 ? <Empty>No tokens created by this wallet yet.</Empty> : summary.created.map((m) => <MarketDetailRow key={m.token} market={m} />)}
          </Module>

          <Module>
            <ModuleHeader index="02" title={`Holdings · ${summary.holdings.length}`} action={<span className="font-mono text-[11px] text-ink-muted">{formatUsd(summary.holdingsUsd)}</span>} />
            {summary.holdings.length === 0 ? (
              <Empty>No launchpad token balances indexed for this wallet.</Empty>
            ) : (
              summary.holdings.map((h) => (
                <Link key={h.token} href={`/token/${h.token}`} className="rail flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                  <span className="flex items-center gap-3 min-w-0">
                    <TokenLogo src={h.imageUrl} symbol={h.symbol} size={30} />
                    <span className="min-w-0">
                      <span className="block font-medium text-[14px] truncate">
                        {h.name} <span className="text-ink-muted font-mono text-[11px]">{h.symbol}</span>
                      </span>
                      <span className="block text-[12px] text-ink-secondary">
                        vs {h.stockSymbol} · {h.priceUsd === null ? 'no price yet' : `${formatUsd(h.priceUsd)} each`}
                      </span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block display num text-[15px]">{formatUsd(h.valueUsd)}</span>
                    <span className="block font-mono text-[11px] text-ink-muted">{formatNumber(h.balance, 2)} {h.symbol}</span>
                  </span>
                </Link>
              ))
            )}
          </Module>

          <Module>
            <ModuleHeader index="03" title="Recent trades" />
            {summary.recentSwaps.length === 0 ? (
              <Empty>No trades by this wallet yet.</Empty>
            ) : (
              summary.recentSwaps.map((s) => (
                <div key={`${s.txHash}:${s.token}`} className="rail grid grid-cols-[64px_minmax(0,1fr)_auto_auto] gap-3 px-4 py-2.5 border-b border-line last:border-b-0 items-center text-[13px]">
                  <span className="flex items-center gap-1">
                    <Badge tone={s.side === 'buy' ? 'positive' : 'danger'}>{s.side}</Badge>
                  </span>
                  <span className="min-w-0">
                    <Link href={`/token/${s.token}`} className="font-medium hover:text-primary truncate block">
                      {s.name} <span className="text-ink-muted font-mono text-[11px]">{s.symbol}</span>
                      {s.isCreator && <Badge tone="warning" className="ml-2">dev</Badge>}
                    </Link>
                    <span className="block font-mono text-[11px] text-ink-muted">
                      <TimeAgo value={s.blockTime} placeholder="…" />
                    </span>
                  </span>
                  <span className="text-right font-mono num">
                    <span className="block">{formatUsd(s.amountUsd)}</span>
                    <span className="block text-ink-muted text-[11px]">
                      {formatNumber(s.amountToken, 2)} {s.symbol} · {formatNumber(s.amountStock, 6)} {s.stockSymbol}
                    </span>
                  </span>
                  <TxLink hash={s.txHash} className="text-[12px]">
                    tx
                  </TxLink>
                </div>
              ))
            )}
          </Module>
        </div>

        <div className="flex flex-col gap-5">
          <Module ticks>
            <ModuleHeader title="Claimable fees" action={<span className="font-mono text-[11px] text-ink-muted">{formatUsd(summary.claimableUsd)}</span>} />
            <ClaimFees wallet={wallet} claimable={summary.claimable} />
          </Module>
          <Module>
            <ModuleHeader title="Creator record" />
            <div className="px-4 py-2">
              <KeyValue k="Tokens launched" v={String(summary.creator.tokens)} />
              <KeyValue k="Trades on their tokens" v={formatNumber(summary.creator.trades, 0)} />
              <KeyValue k="Unique traders" v={formatNumber(summary.creator.uniqueTraders, 0)} />
              <KeyValue k="Holders across tokens" v={formatNumber(summary.creator.holders, 0)} />
              <KeyValue k="Volume attracted" v={formatUsd(summary.creator.volumeUsd)} />
              <KeyValue k="Fees earned · lifetime" v={formatUsd(summary.creator.feesEarnedUsd)} />
              {summary.creator.feesByStock.map((f) => (
                <KeyValue key={f.stock} k={`· in ${f.symbol}`} v={`${formatNumber(f.amount, 6)} ${f.symbol}${f.usd !== null ? ` · ${formatUsd(f.usd)}` : ''}`} />
              ))}
            </div>
            <p className="px-4 py-2.5 border-t border-line text-[11px] text-ink-muted">Every figure is read from confirmed Base blocks. Fees earned counts the creator's 70% of hook fees, claimed or not.</p>
          </Module>
        </div>
      </div>
    </div>
  );
}
