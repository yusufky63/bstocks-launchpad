'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Flame } from 'lucide-react';
import { useState } from 'react';
import { erc20Abi, type Address, type Hash } from 'viem';
import { useAccount, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { base } from 'wagmi/chains';

import { formatAmount, parseAmount } from '@stockpair/core';

import { ConnectButton } from '@/components/layout/connect-button';
import { AmountInput, Checkbox, Segmented } from '@/components/ui/controls';
import { AddressLabel, Banner, TxLink, TxProgress } from '@/components/ui/display';
import { Button, KeyValue } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { BURN_ADDRESS, BURN_BUSY, burnsFromReceipt, describeBurnError, executeBurn, type BurnState } from '@/lib/burn';
import { formatSupplyPct, formatUsd } from '@/lib/format';
import { supplyPercent } from '@/lib/market-view';
import { addPendingBurns } from '@/lib/pending-burns';
import { qk } from '@/lib/queries';
import { shareOf } from '@/lib/trade';
import type { MarketView } from '@/lib/types';

const PCT_CHIPS = [25, 50, 75, 100];

const STATE_COPY: Record<BurnState, string> = {
  IDLE: '',
  AWAITING_WALLET: 'Confirm the burn in your wallet…',
  SUBMITTED: 'Submitted to Base',
  CONFIRMING: 'Waiting for the block…',
  CONFIRMED: 'Burned',
  FAILED: 'Not completed',
};

type BurnMarket = Pick<MarketView, 'token' | 'name' | 'symbol' | 'imageUrl' | 'creator' | 'priceUsd'>;

/**
 * Shown to holders only: a wallet with none of this token has nothing to burn, so the button is not
 * there for it at all. Opens the burn sheet.
 */
export function BurnButton({ market }: { market: BurnMarket }) {
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  const balance = useReadContract({
    address: market.token as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const held = balance.data ?? 0n;
  // Keep the sheet mounted while it is open: burning everything takes the balance to zero, and the
  // success screen has to stay up after that.
  if (!address || (held === 0n && !open)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Burn some of your ${market.symbol}`}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] border border-line text-[13px] font-medium text-ink-secondary hover:text-danger-fg hover:border-danger transition-fast"
      >
        <Flame size={14} strokeWidth={1.75} aria-hidden /> Burn
      </button>
      {open && <BurnSheet market={market} balance={held} onBalanceChange={() => void balance.refetch()} onClose={() => setOpen(false)} />}
    </>
  );
}

function BurnSheet({ market, balance, onBalanceChange, onClose }: { market: BurnMarket; balance: bigint; onBalanceChange: () => void; onClose: () => void }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient({ chainId: base.id });
  const queryClient = useQueryClient();
  const [amountText, setAmountText] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [ack, setAck] = useState(false);
  const [state, setState] = useState<BurnState>('IDLE');
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [burned, setBurned] = useState<bigint | null>(null);

  const onBase = Boolean(address) && chainId === base.id;
  const amount = parseAmount(amountText, 18);
  const tooMuch = amount !== null && amount > balance;
  const busy = BURN_BUSY.includes(state);
  const done = state === 'CONFIRMED';
  const canBurn = onBase && amount !== null && amount > 0n && !tooMuch && ack && !busy && !done;
  const whole = amount === null ? 0 : Number(amount) / 1e18;

  const applyPct = (p: number) => {
    setPct(p);
    const raw = shareOf(balance, p);
    setAmountText(raw === 0n ? '' : formatAmount(raw, 18, 18).replaceAll(',', ''));
  };

  const run = async () => {
    if (!canBurn || amount === null || !address || !walletClient || !publicClient) return;
    setError(null);
    try {
      const { txHash: hash, receipt } = await executeBurn(
        { account: address, walletClient, publicClient },
        { token: market.token as Address, amount },
        { onState: setState, onSubmitted: setTxHash },
      );
      setTxHash(hash);
      setBurned(amount);
      setState('CONFIRMED');
      onBalanceChange();
      // On the page from the receipt at once; the indexer's record replaces it a few seconds later.
      void publicClient
        .getBlock({ blockNumber: receipt.blockNumber })
        .then((block) => addPendingBurns(market.token, burnsFromReceipt(receipt, market, new Date(Number(block.timestamp) * 1000))))
        .catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: qk.burns(market.token) });
      void queryClient.invalidateQueries({ queryKey: qk.holders(market.token) });
      void queryClient.invalidateQueries({ queryKey: qk.token(market.token) });
    } catch (err) {
      setError(describeBurnError(err));
      setState('FAILED');
    }
  };

  const footer = done ? (
    <Button full onClick={onClose}>
      Done
    </Button>
  ) : !onBase ? (
    <ConnectButton full size="lg" />
  ) : busy ? (
    <Button full size="lg" loading disabled>
      {STATE_COPY[state]}
    </Button>
  ) : (
    <Button full size="lg" variant="danger" disabled={!canBurn} onClick={() => void run()}>
      {amount && amount > 0n ? `Burn ${formatAmount(amount, 18, 2)} ${market.symbol}` : `Burn ${market.symbol}`}
    </Button>
  );

  return (
    <Sheet open onClose={onClose} title={`Burn ${market.symbol}`} locked={busy} footer={footer}>
      <div className="flex flex-col gap-4">
        {done && burned !== null ? (
          <Banner tone="positive">
            {formatAmount(burned, 18, 2)} {market.symbol} burned, {formatSupplyPct(supplyPercent(burned))} of the supply. They sit at the burn address for good.
          </Banner>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <AmountInput value={amountText} onChange={(v) => { setAmountText(v); setPct(null); }} unit={market.symbol} ariaLabel={`Amount of ${market.symbol} to burn`} disabled={busy} />
              <div className="flex items-center justify-between font-mono num text-[12px] text-ink-muted">
                <span>{market.priceUsd === null ? 'no price yet' : `≈ ${formatUsd(whole * market.priceUsd)} at the current price`}</span>
                <span>{formatSupplyPct(amount === null ? 0 : supplyPercent(amount))} of supply</span>
              </div>
            </div>
            <Segmented<number>
              size="sm"
              ariaLabel="Share of your balance to burn"
              value={pct}
              onChange={applyPct}
              options={PCT_CHIPS.map((p) => ({ value: p, label: p === 100 ? 'Max' : `${p}%`, disabled: busy || balance === 0n, title: `${p}% of your ${market.symbol}` }))}
            />
            <div className="flex items-center justify-between text-[13px] text-ink-secondary">
              <span>Your balance</span>
              <span className="font-mono num">
                {formatAmount(balance, 18, 2)} {market.symbol}
              </span>
            </div>
            {amountText && amount === null && <p className="text-[12px] text-danger-fg">Enter a valid amount with at most 18 decimals.</p>}
            {tooMuch && <p className="text-[12px] text-danger-fg">You hold {formatAmount(balance, 18, 2)} {market.symbol}.</p>}
            <div>
              <KeyValue k="Sent to" v={<AddressLabel address={BURN_ADDRESS} explorer chars={6} />} />
              <KeyValue k="Network" v="Base" />
            </div>
            <Banner tone="danger">
              <span className="block">
                Burning is permanent. The tokens go to {BURN_ADDRESS.slice(0, 6)}…{BURN_ADDRESS.slice(-4)}, an address nobody holds the key to, and can never be moved again. Nobody is paid for them, and this site cannot undo it.
              </span>
              <Checkbox checked={ack} onChange={setAck} disabled={busy} className="mt-2.5">
                I understand these tokens are gone for good
              </Checkbox>
            </Banner>
          </>
        )}

        {state !== 'IDLE' && state !== 'FAILED' && (
          <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2">
            <div className="text-[13px] text-ink-secondary">{STATE_COPY[state]}</div>
            {(state === 'SUBMITTED' || state === 'CONFIRMING' || state === 'CONFIRMED') && <TxProgress state={state} txHash={txHash} />}
          </div>
        )}
        {state === 'FAILED' && txHash && <TxLink hash={txHash} className="text-[12px]" />}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Sheet>
  );
}
