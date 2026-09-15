'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hash } from 'viem';
import { useAccount, useReadContracts } from 'wagmi';
import { base } from 'wagmi/chains';

import { formatAmount, parseAmount } from '@stockpair/core';

import { ConnectButton } from '@/components/layout/connect-button';
import { Banner } from '@/components/ui/display';
import { AmountInput, Segmented } from '@/components/ui/controls';
import { Button, KeyValue, cx } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';
import { bpsToPct, formatPct, formatRatio, formatUsd } from '@/lib/format';
import { qk, useQuote } from '@/lib/queries';
import { useSlippage } from '@/lib/settings';
import { minOutFor, shareOf } from '@/lib/trade';
import type { MarketView } from '@/lib/types';

import { SlippageControl } from './slippage-control';
import { TradeReviewSheet } from './trade-review-sheet';

const PCT_CHIPS = [25, 50, 75, 100];

/** The most important interaction in the app: amount first, live executable quote, sticky CTA. */
export function TradePanel({ market, initialSide = 'buy', onTraded, className }: { market: MarketView; initialSide?: 'buy' | 'sell'; onTraded?: () => void; className?: string }) {
  const deployment = publicEnv.deployment;
  const { address, isConnected, chainId } = useAccount();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide);
  const [amountText, setAmountText] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [review, setReview] = useState(false);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const { slippageBps } = useSlippage();

  const [seenSide, setSeenSide] = useState(initialSide);
  if (initialSide !== seenSide) {
    setSeenSide(initialSide);
    setSide(initialSide);
    // Clear the amount the way the in-panel toggle does. Buy and sell are denominated in different
    // tokens with different decimals, so carrying the number across means the next quote is for a
    // different trade than the one the field is showing.
    setAmountText('');
    setPct(null);
  }

  const stockAddress = market.stock.address as Address;
  const tokenAddress = market.token as Address;
  const buy = side === 'buy';
  const inputAddress = buy ? stockAddress : tokenAddress;
  const inputDecimals = buy ? market.stock.decimals : 18;
  const outputDecimals = buy ? 18 : market.stock.decimals;
  const inputSymbol = buy ? market.stock.symbol : market.symbol;
  const outputSymbol = buy ? market.symbol : market.stock.symbol;
  const amountIn = parseAmount(amountText, inputDecimals);
  const onBase = isConnected && !!address && chainId === base.id;

  const balances = useReadContracts({
    contracts: [
      { address: stockAddress, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined },
      { address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined },
    ],
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
  });
  const stockBalance = (balances.data?.[0]?.result as bigint | undefined) ?? null;
  const tokenBalance = (balances.data?.[1]?.result as bigint | undefined) ?? null;
  const balance = buy ? stockBalance : tokenBalance;

  const quote = useQuote(market.token, side, amountIn);
  const q = quote.data;
  const insufficient = amountIn !== null && balance !== null && amountIn > balance;
  const stockUsd = market.stockUsd;

  // Clear the last hash when the user starts a new trade, but not when our own success handler
  // resets the amount — that would erase the confirmation the moment it appeared.
  const justTraded = useRef(false);
  useEffect(() => {
    if (justTraded.current) {
      justTraded.current = false;
      return;
    }
    setLastTx(null);
  }, [side, amountText]);

  const applyPct = (p: number) => {
    if (balance === null) return;
    setPct(p);
    const raw = shareOf(balance, p);
    setAmountText(raw === 0n ? '' : formatAmount(raw, inputDecimals, inputDecimals).replaceAll(',', ''));
  };

  const estimateOut = q ? formatAmount(BigInt(q.amountOut), outputDecimals, buy ? 2 : 6) : null;
  // USD on both sides: stock amounts via the Chainlink quote, token amounts via the last pool price.
  const stockAmountUsd = (raw: bigint) => (stockUsd === null ? null : (Number(raw) / 10 ** market.stock.decimals) * stockUsd);
  const tokenAmountUsd = (raw: bigint) => (market.priceUsd === null ? null : (Number(raw) / 1e18) * market.priceUsd);
  const inputUsd = amountIn === null || amountIn === 0n ? null : buy ? stockAmountUsd(amountIn) : tokenAmountUsd(amountIn);
  const outputUsd = q ? (buy ? tokenAmountUsd(BigInt(q.amountOut)) : stockAmountUsd(BigInt(q.amountOut))) : null;
  // The quote query keeps serving the previous result while a new one is in flight, and reports it
  // as a success. Without this equality check the CTA stays live after the amount changes, so a
  // confirmation can carry the old quote's minAmountOut against the new, larger input — a swap with
  // effectively no slippage floor. Match the quote to what is on screen before allowing review.
  const quoteMatches = Boolean(q && amountIn !== null && q.amountIn === amountIn.toString() && q.side === side);
  const canReview = Boolean(
    onBase && deployment && amountIn && amountIn > 0n && q && !insufficient && quote.status === 'success' && quoteMatches && !quote.isPlaceholderData,
  );
  const ctaLabel = buy ? `Buy ${market.symbol}${inputUsd !== null ? ` · ${formatUsd(inputUsd)}` : ''}` : `Sell ${market.symbol}${inputUsd !== null ? ` · ≈ ${formatUsd(inputUsd)}` : ''}`;

  const onDone = (hash: Hash) => {
    setLastTx(hash);
    // Close the sheet explicitly. It used to unmount because clearing the amount removed the quote
    // that kept it mounted, which took the success screen and the transaction hash with it.
    setReview(false);
    justTraded.current = true;
    setAmountText('');
    setPct(null);
    void balances.refetch();
    void queryClient.invalidateQueries({ queryKey: qk.swaps(market.token) });
    void queryClient.invalidateQueries({ queryKey: qk.candles(market.token) });
    void queryClient.invalidateQueries({ queryKey: qk.holders(market.token) });
    void queryClient.invalidateQueries({ queryKey: qk.token(market.token) });
    onTraded?.();
  };

  return (
    <div className={cx('flex flex-col', className)}>
      <div className="p-3 border-b border-line">
        <Segmented<'buy' | 'sell'>
          ariaLabel="Trade side"
          value={side}
          onChange={(s) => {
            setSide(s);
            setPct(null);
            setAmountText('');
          }}
          options={[
            { value: 'buy', label: 'Buy', tone: 'buy' },
            { value: 'sell', label: 'Sell', tone: 'sell' },
          ]}
        />
      </div>

      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
          <span>
            {market.symbol} · {market.priceUsd === null ? 'no trades yet' : formatUsd(market.priceUsd)} <span className="text-ink-muted">{market.stockFeedStatus === 'live' ? 'live' : 'last close'}</span>
          </span>
          <span className="font-mono num">{formatRatio(market.priceInStock, market.stock.symbol)}</span>
        </div>

        <div className="flex flex-col gap-1">
          <AmountInput value={amountText} onChange={(v) => { setAmountText(v); setPct(null); }} unit={inputSymbol} ariaLabel={`Amount of ${inputSymbol} to ${side === 'buy' ? 'spend' : 'sell'}`} />
          <div className="flex items-center justify-between font-mono num text-[12px] text-ink-muted">
            <span>{inputUsd === null ? (amountIn && amountIn > 0n ? 'USD value unavailable' : '≈ $0.00') : `≈ ${formatUsd(inputUsd)}`}</span>
            <span>{buy ? `1 ${market.stock.symbol} = ${formatUsd(stockUsd)}` : `1 ${market.symbol} = ${formatUsd(market.priceUsd)}`}</span>
          </div>
        </div>

        <Segmented<number>
          size="sm"
          ariaLabel={buy ? 'Share of stock balance to spend' : 'Share of position to sell'}
          value={pct}
          onChange={applyPct}
          options={PCT_CHIPS.map((p) => ({ value: p, label: p === 100 ? 'Max' : `${p}%`, disabled: !onBase || balance === null || balance === 0n, title: !onBase ? 'Connect a wallet on Base to use balance presets' : balance === 0n ? `No ${inputSymbol} to ${buy ? 'spend' : 'sell'}` : `${p}% of your ${inputSymbol}` }))}
        />

        <div className="flex items-center justify-between text-[13px] text-ink-secondary">
          <span>{buy ? `${inputSymbol} balance` : 'Your position'}</span>
          <span className="font-mono num">{balance === null ? '—' : `${formatAmount(balance, inputDecimals, buy ? 6 : 2)} ${inputSymbol}`}</span>
        </div>
        {amountText && amountIn === null && <p className="text-[12px] text-danger-fg">Enter a valid amount with at most {inputDecimals} decimals.</p>}
        {insufficient && (
          <p className="text-[12px] text-danger-fg">
            Not enough {inputSymbol}.
            {buy && (
              <>
                {' '}
                <a href={`https://basestocks.finance/stocks/${market.stock.address}`} target="_blank" rel="noreferrer noopener" className="text-primary font-medium">
                  Buy {market.stock.symbol} on BStocks →
                </a>
              </>
            )}
          </p>
        )}
        {buy && onBase && stockBalance === 0n && (
          <p className="text-[12px] text-ink-muted border border-dashed border-line rounded-[6px] px-3 py-2">
            You need {market.stock.symbol} to buy. Get it on{' '}
            <a href={`https://basestocks.finance/stocks/${market.stock.address}`} target="_blank" rel="noreferrer noopener" className="text-primary font-medium">
              BStocks
            </a>{' '}
            or any Base DEX, then come back.
          </p>
        )}

        <div className="border-t border-line pt-3 min-h-[92px]" aria-live="polite">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Live quote</span>
            <SlippageControl />
          </div>
          {(amountIn === null || amountIn === 0n) && <p className="text-[13px] text-ink-muted">Enter an amount to see a live quote from the pool.</p>}
          {amountIn !== null && amountIn > 0n && quote.isPending && !q && <p className="text-[13px] text-ink-muted">Asking the pool…</p>}
          {quote.isError && <p className="text-[13px] text-danger-fg">{quote.error.message}</p>}
          {q && amountIn !== null && amountIn > 0n && (
            <div className={cx(quote.isFetching && 'opacity-60 transition-fast')}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-ink-secondary">
                  You receive (est.)
                  {outputUsd !== null && <span className="block font-mono num text-[12px] text-ink-muted">≈ {formatUsd(outputUsd)}</span>}
                </span>
                <span className="display num text-[22px] truncate">
                  {estimateOut} <span className="text-[13px] font-mono font-normal tracking-normal text-ink-secondary">{outputSymbol}</span>
                </span>
              </div>
              <KeyValue k="Price" v={formatRatio(q.executionPrice, `${market.stock.symbol}/${market.symbol}`)} />
              <KeyValue k="Price impact" v={<span className={cx((q.priceImpactPercent ?? 0) > 5 && 'text-warning-fg')}>{formatPct(q.priceImpactPercent, { sign: true })}</span>} />
              <KeyValue k={`Fee · in ${market.stock.symbol}`} v={<span className={cx(q.feeBps > 100 && 'text-warning-fg')}>{bpsToPct(q.feeBps)}{q.feeBps > 100 ? ' · anti-snipe' : ''}</span>} />
              <KeyValue k="Minimum received" v={`${formatAmount(minOutFor(BigInt(q.amountOut), slippageBps), outputDecimals, buy ? 2 : 6)} ${outputSymbol}`} />
            </div>
          )}
        </div>

        {q && q.feeBps > 100 && <Banner tone="warning">Anti-snipe window: the fee is {bpsToPct(q.feeBps)} for a few more seconds, then 1%.</Banner>}
        {lastTx && (
          <Banner tone="positive">
            Swap confirmed.{' '}
            <a href={`https://basescan.org/tx/${lastTx}`} target="_blank" rel="noreferrer" className="text-primary font-medium">
              View on Basescan
            </a>
          </Banner>
        )}
        {!deployment && <Banner tone="danger">Contracts are not configured on this server.</Banner>}

        {!isConnected ? (
          <ConnectButton full size="lg" />
        ) : !onBase ? (
          <ConnectButton full size="lg" />
        ) : (
          <Button full size="lg" variant={buy ? 'primary' : 'ink'} disabled={!canReview} onClick={() => setReview(true)}>
            {ctaLabel} <ArrowUpRight size={16} strokeWidth={1.75} />
          </Button>
        )}

        <p className="text-[12px] text-ink-muted">
          Pool {market.symbol}/{market.stock.symbol} on Uniswap v4 · 1% fee in {market.stock.symbol}, 70% to the creator · liquidity locked forever.
        </p>
      </div>

      {q && amountIn !== null && deployment && quoteMatches && (
        <TradeReviewSheet open={review} onClose={() => setReview(false)} onDone={onDone} market={market} quote={q} amountIn={amountIn} slippageBps={slippageBps} router={deployment.router} />
      )}
    </div>
  );
}
