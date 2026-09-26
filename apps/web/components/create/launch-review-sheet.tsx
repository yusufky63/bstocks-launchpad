'use client';

import { useCallback, useState } from 'react';
import type { Hash } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { base } from 'wagmi/chains';

import { formatAmount, type LaunchBuyQuote } from '@stockpair/core';

import { AddressLabel, Banner, TxLink, TxProgress } from '@/components/ui/display';
import { Button, KeyValue } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { bpsToPct, formatUsd } from '@/lib/format';
import { describeLaunchError, devBuyMinOut, launchNeedsReview } from '@/lib/launch';
import { LAUNCH_BUSY, executeLaunch, pinOnce, type LaunchMode, type LaunchPlan, type LaunchResult, type LaunchState } from '@/lib/launch-exec';

/** Everything the creator is shown before confirming, read fresh and then frozen. */
export type ReviewedLaunch = {
  plan: LaunchPlan;
  stock: { symbol: string; ticker: string; name: string; decimals: number };
  /** The Chainlink price the factory's own preview used, 8 decimals. */
  stockUsd8: bigint;
  quote: LaunchBuyQuote | null;
};

const STATE_COPY: Record<LaunchState, string> = {
  IDLE: '',
  PINNING: 'Pinning the profile to IPFS…',
  CHECKING: 'Checking the launch…',
  APPROVAL: 'Approve the amount in your wallet…',
  REQUOTING: 'Checking the price again…',
  AWAITING_WALLET: 'Confirm the launch in your wallet…',
  SUBMITTED: 'Submitted to Base',
  CONFIRMING: 'Waiting for the block…',
  CONFIRMED: 'Launched',
  FAILED: 'Not launched',
};

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** The Expires row: the deadline actually signed once there is one, never a guess made when the sheet opened. */
export function expiresText(deadline: bigint | null): string {
  return deadline === null ? '10 minutes after you confirm' : `${clock.format(new Date(Number(deadline) * 1000))} (10 minutes)`;
}

/** What the Profile row promises. A fixed profile's site presentation can still change by signed message. */
export function profileRowText(metadataEditable: boolean): string {
  return metadataEditable
    ? 'Editable onchain by you until you lock it'
    : 'Name, symbol, supply and contract URI fixed onchain · what this site shows can still be updated by your signed message';
}

/** Review → pin → (approve) → confirm in the wallet → receipt. Shown before every launch. */
export function LaunchReviewSheet({
  open,
  onClose,
  reviewed,
  pin,
  onLaunched,
  onReviewAgain,
}: {
  open: boolean;
  onClose: () => void;
  reviewed: ReviewedLaunch;
  pin: () => Promise<string>;
  onLaunched: (result: LaunchResult) => void;
  /** Close this sheet and read every term again for the wallet connected now. */
  onReviewAgain: () => void;
}) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient({ chainId: base.id });
  const [state, setState] = useState<LaunchState>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [approvalHash, setApprovalHash] = useState<Hash | undefined>();
  const [mode, setMode] = useState<LaunchMode | null>(null);
  const [deadline, setDeadline] = useState<bigint | null>(null);
  // The sheet is keyed by the review, so this lives exactly as long as the frozen plan it pins for.
  const [pinForReview] = useState(() => pinOnce(pin));

  const { plan, stock, quote } = reviewed;
  const busy = LAUNCH_BUSY.includes(state);
  const stockUsd = Number(reviewed.stockUsd8) / 1e8;
  const stockText = (raw: bigint) => `${formatAmount(raw, stock.decimals, 6)} ${stock.symbol}`;
  const stockUsdText = (raw: bigint) => formatUsd((Number(raw) / 10 ** stock.decimals) * stockUsd);
  const feeEth = Number(plan.creationFee) / 1e18;
  // The token address and the quote belong to the reviewed wallet; another one needs its own review.
  const walletChanged = address?.toLowerCase() !== plan.account.toLowerCase() || chainId !== plan.chainId;

  const reset = useCallback(() => {
    setState('IDLE');
    setError(null);
    setNeedsReview(false);
    setTxHash(undefined);
    setApprovalHash(undefined);
    setMode(null);
    setDeadline(null);
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  const run = async () => {
    if (!address || !walletClient || !publicClient) {
      setError('Connect a wallet on Base first.');
      setState('FAILED');
      return;
    }
    setError(null);
    setNeedsReview(false);
    setDeadline(null);
    try {
      const result = await executeLaunch({ account: address, chainId, walletClient, publicClient }, plan, pinForReview, {
        onState: setState,
        onApproval: setApprovalHash,
        onMode: setMode,
        onSubmitted: (h) => setTxHash(h),
        onDeadline: setDeadline,
      });
      setTxHash(result.txHash);
      setState('CONFIRMED');
      onLaunched(result);
    } catch (err) {
      setError(describeLaunchError(err, { stock: stock.symbol, ticker: stock.ticker }));
      setNeedsReview(launchNeedsReview(err));
      setState('FAILED');
    }
  };

  const title = state === 'CONFIRMED' ? 'Launched' : state === 'FAILED' ? 'Not launched' : 'Review launch';
  const label = plan.buy ? `Create and buy · ${feeEth} ETH` : `Create token · ${feeEth} ETH`;

  const reviewAgain = () => {
    reset();
    onReviewAgain();
  };

  const cta = () => {
    if (state === 'FAILED')
      return (
        <div className="flex gap-2">
          <Button variant="secondary" full onClick={handleClose}>
            Close
          </Button>
          {/* Retrying terms that no longer hold fails the same way every time. */}
          {needsReview || walletChanged ? (
            <Button full onClick={reviewAgain}>
              Review again
            </Button>
          ) : (
            <Button full onClick={() => void run()}>
              Try again
            </Button>
          )}
        </div>
      );
    if (state === 'IDLE')
      return walletChanged ? (
        <Button full size="lg" onClick={reviewAgain}>
          Review again
        </Button>
      ) : (
        <Button full size="lg" onClick={() => void run()}>
          {label}
        </Button>
      );
    return (
      <Button full size="lg" loading disabled>
        {STATE_COPY[state]}
      </Button>
    );
  };

  return (
    <Sheet open={open} onClose={handleClose} title={title} locked={busy || state === 'CONFIRMED'} footer={cta()}>
      <div className="flex flex-col gap-4">
        <div>
          <KeyValue k="Token" v={`${plan.name} · ${plan.symbol}`} mono={false} />
          <KeyValue k="Paired stock" v={`${stock.symbol} · ${stock.name}`} mono={false} />
          <KeyValue k="Supply" v="1,000,000,000 · all of it locked in the pool forever" mono={false} />
          <KeyValue k="Opening valuation" v={`${formatUsd(Number(plan.reviewedFdv) / 1e8)} FDV`} />
          <KeyValue k="Creation fee" v={`${feeEth} ETH + gas`} />
          <KeyValue k="Token address" v={<AddressLabel address={plan.predicted} chars={8} />} />
          <KeyValue k="Profile" v={profileRowText(plan.metadataEditable)} mono={false} />
          {/* A plain launch() carries no deadline at all, so it gets no row. */}
          {!plan.legacy && <KeyValue k="Expires" v={expiresText(deadline)} mono={deadline !== null} />}
        </div>

        {plan.buy && quote && (
          <div className="border border-line rounded-[8px] px-3 py-1">
            <div className="pt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Buy at launch</div>
            <KeyValue k="You spend" v={`${stockText(plan.buy.stockIn)} · ≈ ${stockUsdText(plan.buy.stockIn).replace('$', '')} USDC`} />
            <KeyValue k="You receive" v={`≈ ${formatAmount(quote.tokensOut, 18, 2)} ${plan.symbol}`} />
            <KeyValue k="Share of supply" v={`${(Number(quote.supplyPpm) / 10_000).toFixed(2)}%`} />
            <KeyValue k="Minimum received" v={`${formatAmount(devBuyMinOut(quote.tokensOut, plan.buy.toleranceBps), 18, 2)} ${plan.symbol}`} />
            <KeyValue k="Fee 1%" v={`${stockText(quote.fee)} · 70% (${stockText(quote.creatorFeeBack)}) back to you`} />
            <KeyValue k="Tolerance" v={bpsToPct(plan.buy.toleranceBps)} />
          </div>
        )}

        {state === 'IDLE' && walletChanged && (
          <Banner tone="warning">Your wallet or network changed since you reviewed. The token address and the quote belong to the wallet you reviewed with, so review again with the one connected now.</Banner>
        )}

        {state === 'IDLE' && (
          <div className="flex flex-col gap-2 text-[13px] text-ink-secondary">
            {plan.buy ? (
              <>
                <p>One confirmation if your wallet can batch the approval with the launch, otherwise two: the approval, then the launch. If the launch fails, nothing is launched.</p>
                <p>
                  Approve exactly {stockText(plan.buy.stockIn)} for the BStocks launch factory. Only a launch you send yourself can use it.
                </p>
              </>
            ) : (
              <p>One transaction. If any part fails, nothing is launched.</p>
            )}
          </div>
        )}

        {state !== 'IDLE' && state !== 'FAILED' && (
          <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2">
            <div className="text-[13px] text-ink-secondary">{state === 'APPROVAL' && plan.buy ? `Approve ${stockText(plan.buy.stockIn)} in your wallet…` : STATE_COPY[state]}</div>
            {mode === 'sequential' && plan.buy && <div className="font-mono text-[11px] text-ink-muted">Approve, then launch · two confirmations</div>}
            {mode === 'batched' && <div className="font-mono text-[11px] text-ink-muted">Approve + launch · one confirmation</div>}
            {(state === 'SUBMITTED' || state === 'CONFIRMING' || state === 'CONFIRMED') && <TxProgress state={state} txHash={txHash} />}
            {approvalHash && state !== 'CONFIRMED' && (
              <TxLink hash={approvalHash} className="text-[12px]">
                Approval transaction
              </TxLink>
            )}
          </div>
        )}
        {state === 'CONFIRMED' && <Banner tone="positive">Launched. Opening the token page…</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Sheet>
  );
}
