'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Hex } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';

import { stockPairHookAbi } from '@stockpair/core';

import { StockTile } from '@/components/stock/stock-coin';
import { Banner, TxLink } from '@/components/ui/display';
import { Button, Empty} from '@/components/ui/primitives';
import { builderDataSuffix } from '@/lib/attribution';
import { claimsByHook } from '@/lib/deployments';
import { formatNumber, formatUsd } from '@/lib/format';
import { describeTradeError } from '@/lib/trade';

export type Claimable = { stock: string; symbol: string; ticker: string; amount: number; amountRaw: string; usd: number | null; hook: string };

/**
 * Creator fees accrued in the hooks. Each hook books its own claims, so a wallet with tokens on more
 * than one deployment claims once per hook; the rows still show one line per stock.
 *
 * `unreadHooks` are hooks whose balances could not be read just now. The rest are still shown and
 * claimable, so one unreachable deployment never hides another's fees.
 */
export function ClaimFees({ wallet, claimable, unreadHooks = [] }: { wallet: string; claimable: Claimable[] | null; unreadHooks?: string[] }) {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const router = useRouter();
  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const isOwner = address?.toLowerCase() === wallet.toLowerCase() && chainId === base.id;
  const batches = claimsByHook(claimable ?? []);

  // Declared before any early return, so the hook order is the same whatever the read returned.
  const claim = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Contracts are not configured.');
      let last: Hex | null = null;
      for (const batch of batches) {
        const hash = await writeContractAsync({
          address: batch.hook,
          abi: stockPairHookAbi,
          functionName: 'claimMany',
          args: [batch.stocks],
          chainId: base.id,
          dataSuffix: builderDataSuffix(),
        });
        setTxHash(hash);
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('The claim reverted.');
        last = hash;
      }
      return last;
    },
    onSuccess: () => router.refresh(),
  });

  // Null means the chain read failed. Saying "nothing to claim" then would hide a real balance and,
  // worse, hide the button that withdraws it.
  if (claimable === null) {
    return <Empty>Claimable fees could not be read from the chain just now. Reload in a moment — nothing is lost.</Empty>;
  }
  const partial =
    unreadHooks.length > 0 ? (
      <Banner tone="warning">
        Fees on {unreadHooks.length === 1 ? 'one fee contract' : `${unreadHooks.length} fee contracts`} could not be read just now, so they are not listed here. Reload in a moment — nothing is lost.
      </Banner>
    ) : null;
  const totalUsd = claimable.reduce((sum, c) => sum + (c.usd ?? 0), 0);
  const rows = [...claimable.reduce((byStock, c) => {
    const key = c.stock.toLowerCase();
    const prev = byStock.get(key);
    byStock.set(key, prev ? { ...prev, amount: prev.amount + c.amount, usd: prev.usd === null || c.usd === null ? null : prev.usd + c.usd } : c);
    return byStock;
  }, new Map<string, Claimable>()).values()];

  if (claimable.length === 0)
    return (
      <div className="px-4 py-4 flex flex-col gap-3">
        {partial}
        <p className="text-[14px] text-ink-secondary">{partial ? 'Nothing to claim on the fee contracts that answered.' : 'Nothing to claim right now.'} Fees accrue with every swap on tokens this wallet created.</p>
      </div>
    );
  return (
    <div className="flex flex-col">
      {partial && <div className="px-4 pt-3">{partial}</div>}
      {rows.map((c) => (
        <div key={c.stock} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
          <span className="flex items-center gap-3">
            <StockTile ticker={c.ticker} size={28} />
            <span className="font-medium text-[14px]">{c.symbol}</span>
          </span>
          <span className="text-right">
            <span className="block display num text-[16px]">{formatNumber(c.amount, 6)}</span>
            <span className="block font-mono text-[11px] text-ink-muted">{formatUsd(c.usd)}</span>
          </span>
        </div>
      ))}
      <div className="p-4 flex flex-col gap-3">
        {totalUsd > 0 && !partial && (
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-ink-secondary">Total</span>
            <span className="display num text-[22px]">{formatUsd(totalUsd)}</span>
          </div>
        )}
        {isOwner ? (
          <>
            <Button full loading={claim.isPending} onClick={() => claim.mutate()}>
              Claim all
            </Button>
            {batches.length > 1 && <p className="text-[12px] text-ink-muted">{batches.length} transactions, one for each fee contract that holds your fees.</p>}
          </>
        ) : (
          <p className="text-[13px] text-ink-muted">Connect this wallet to claim.</p>
        )}
        {claim.isError && <Banner tone="danger">{describeTradeError(claim.error)}</Banner>}
        {claim.isSuccess && txHash && (
          <Banner tone="positive">
            Claimed. <TxLink hash={txHash} />
          </Banner>
        )}
      </div>
    </div>
  );
}
