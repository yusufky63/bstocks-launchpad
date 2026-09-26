'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hash } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { base } from 'wagmi/chains';

import { formatAmount } from '@stockpair/core';

import { Checkbox } from '@/components/ui/controls';
import { Banner, TxLink, TxProgress } from '@/components/ui/display';
import { Button, KeyValue, cx } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { bpsToPct, formatPct, formatRatio, formatUsd } from '@/lib/format';
import { impactLevel, slippageLevel } from '@/lib/settings';
import { BUSY_STATES, describeTradeError, executeSwap, minOutFor, type TradeState } from '@/lib/trade';
import type { QuoteView, TradeMarket } from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onDone?: (hash: Hash) => void;
  market: TradeMarket;
  quote: QuoteView;
  amountIn: bigint;
  slippageBps: number;
  router: Address;
}

const STATE_COPY: Record<TradeState, string> = {
  IDLE: '',
  CHECKING: 'Checking the router allowance…',
  APPROVAL: 'Approve the router in your wallet…',
  AWAITING_WALLET: 'Confirm the swap in your wallet…',
  SUBMITTED: 'Submitted to Base',
  CONFIRMING: 'Waiting for the block…',
  CONFIRMED: 'Confirmed',
  FAILED: 'Not completed',
};

/** Review → confirm in the wallet → Submitted / In a block / Confirmed. */
export function TradeReviewSheet({ open, onClose, onDone, market, quote, amountIn, slippageBps, router }: Props) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient({ chainId: base.id });
  const [state, setState] = useState<TradeState>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [approvalHash, setApprovalHash] = useState<Hash | undefined>();
  const [mode, setMode] = useState<'batched' | 'sequential' | null>(null);
  const [impactAck, setImpactAck] = useState(false);
  const doneReported = useRef(false);

  const buy = quote.side === 'buy';
  const inputDecimals = buy ? market.stock.decimals : 18;
  const outputDecimals = buy ? 18 : market.stock.decimals;
  const inputSymbol = buy ? market.stock.symbol : market.symbol;
  const outputSymbol = buy ? market.symbol : market.stock.symbol;
  const amountOut = BigInt(quote.amountOut);
  const minOut = minOutFor(amountOut, slippageBps);
  const inputToken = (buy ? market.stock.address : market.token) as Address;
  const stockUsd = market.stockUsd;
  const stockAmount = Number(buy ? amountIn : amountOut) / 10 ** market.stock.decimals;
  const usdValue = stockUsd === null ? null : stockAmount * stockUsd;
  const busy = BUSY_STATES.includes(state);
  const impact = impactLevel(quote.priceImpactPercent);
  const impactPct = formatPct(quote.priceImpactPercent, { sign: false });
  // Price impact never blocks a trade by itself; at the severe tier it takes one deliberate tick.
  const needsAck = impact === 'severe' && !impactAck;
  const canConfirm = state === 'IDLE' || state === 'FAILED';

  const reset = useCallback(() => {
    setState('IDLE');
    setError(null);
    setTxHash(undefined);
    setApprovalHash(undefined);
    setMode(null);
    setImpactAck(false);
    doneReported.current = false;
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  useEffect(() => {
    if (state === 'CONFIRMED' && txHash && !doneReported.current) {
      doneReported.current = true;
      onDone?.(txHash);
    }
  }, [state, txHash, onDone]);

  const run = async () => {
    if (needsAck || busy) return;
    if (!address || !walletClient || !publicClient) {
      setError('Connect a wallet on Base first.');
      setState('FAILED');
      return;
    }
    setError(null);
    try {
      const result = await executeSwap(
        { account: address, walletClient, publicClient },
        { quote, amountIn, minOut, inputToken, router },
        { onState: setState, onApproval: setApprovalHash, onMode: setMode, onSubmitted: (h) => setTxHash(h) },
      );
      setTxHash(result.txHash);
      setState('CONFIRMED');
    } catch (err) {
      setError(describeTradeError(err));
      setState('FAILED');
    }
  };

  const title = state === 'CONFIRMED' ? (buy ? 'Purchase complete' : 'Sale complete') : state === 'FAILED' ? 'Not completed' : buy ? 'Review buy' : 'Review sell';

  const cta = () => {
    if (state === 'CONFIRMED')
      return (
        <Button full onClick={handleClose}>
          Done
        </Button>
      );
    if (state === 'FAILED')
      return (
        <div className="flex gap-2">
          <Button variant="secondary" full onClick={handleClose}>
            Close
          </Button>
          <Button full disabled={needsAck} onClick={() => void run()}>
            Try again
          </Button>
        </div>
      );
    if (state === 'IDLE')
      return (
        <Button full size="lg" variant={buy ? 'primary' : 'ink'} disabled={needsAck} onClick={() => void run()}>
          {buy ? `Buy ${market.symbol} for ${formatAmount(amountIn, inputDecimals, 6)} ${inputSymbol}` : `Sell ${formatAmount(amountIn, inputDecimals, 2)} ${market.symbol}`}
        </Button>
      );
    return (
      <Button full size="lg" loading disabled>
        {STATE_COPY[state]}
      </Button>
    );
  };

  return (
    <Sheet open={open} onClose={handleClose} title={title} locked={busy} footer={cta()}>
      <div className="flex flex-col gap-4">
        <div className="module-grid grid-cols-2">
          <div className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">You pay</div>
            <div className="display num text-[22px]">
              {formatAmount(amountIn, inputDecimals, buy ? 6 : 2)} <span className="text-[13px] font-mono font-normal tracking-normal text-ink-secondary">{inputSymbol}</span>
            </div>
          </div>
          <div className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">You receive (est.)</div>
            <div className="display num text-[22px]">
              {formatAmount(amountOut, outputDecimals, buy ? 2 : 6)} <span className="text-[13px] font-mono font-normal tracking-normal text-ink-secondary">{outputSymbol}</span>
            </div>
          </div>
        </div>

        <div>
          <KeyValue k="Value" v={usdValue === null ? `${formatRatio(stockAmount)} ${market.stock.symbol}` : `${formatUsd(usdValue)}${market.stockFeedStatus === 'unknown' ? ' · launch quote' : market.stockFeedStatus === 'holding' ? ' · last close' : ''}`} />
          <KeyValue k="Price" v={formatRatio(quote.executionPrice, `${market.stock.symbol} / ${market.symbol}`)} />
          <KeyValue k="Price impact" v={<span className={cx(impact === 'warn' && 'text-warning-fg', impact === 'severe' && 'text-danger-fg')}>{formatPct(quote.priceImpactPercent, { sign: true })}</span>} />
          <KeyValue k={`Fee · in ${market.stock.symbol}`} v={bpsToPct(quote.feeBps)} />
          <KeyValue k="Minimum received" v={`${formatAmount(minOut, outputDecimals, buy ? 2 : 6)} ${outputSymbol}`} />
          <KeyValue k="Slippage tolerance" v={<span className={cx(slippageLevel(slippageBps) === 'high' && 'text-warning-fg')}>{bpsToPct(slippageBps)}</span>} />
          <KeyValue k="Network" v="Base" />
          <KeyValue k="Execution" v={mode === 'batched' ? 'Approve + swap · one confirmation' : mode === 'sequential' ? 'Approve, then swap' : '—'} />
        </div>

        {slippageLevel(slippageBps) === 'high' && canConfirm && (
          <Banner tone="warning">
            Slippage is {bpsToPct(slippageBps)}. You accept as little as {formatAmount(minOut, outputDecimals, buy ? 2 : 6)} {outputSymbol}, {bpsToPct(slippageBps)} below the quote.
          </Banner>
        )}
        {impact === 'warn' && canConfirm && <Banner tone="warning">Price impact above 5%: this order moves the pool by {impactPct}.</Banner>}
        {impact === 'severe' && canConfirm && (
          <Banner tone="danger">
            <span className="block">
              Very high price impact: this trade moves the price by {impactPct}.{' '}
              {buy ? `You get far fewer tokens per ${market.stock.symbol} than the current price suggests.` : `You get far less ${market.stock.symbol} per ${market.symbol} than the current price suggests.`}
            </span>
            <Checkbox checked={impactAck} onChange={setImpactAck} className="mt-2.5">
              I understand the price impact
            </Checkbox>
          </Banner>
        )}

        {state !== 'IDLE' && state !== 'FAILED' && (
          <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2">
            <div className="text-[13px] text-ink-secondary">{STATE_COPY[state]}</div>
            {(state === 'SUBMITTED' || state === 'CONFIRMING' || state === 'CONFIRMED') && <TxProgress state={state} txHash={txHash} />}
            {approvalHash && state !== 'CONFIRMED' && (
              <TxLink hash={approvalHash} className="text-[12px]">
                Approval transaction
              </TxLink>
            )}
          </div>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Sheet>
  );
}
