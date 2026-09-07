'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Address, Hex } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';

import { stockPairHookAbi } from '@stockpair/core';

import { StockTile } from '@/components/stock/stock-coin';
import { Banner, TxLink } from '@/components/ui/display';
import { Button } from '@/components/ui/primitives';
import { builderDataSuffix } from '@/lib/attribution';
import { publicEnv } from '@/lib/env';
import { formatNumber, formatUsd } from '@/lib/format';
import { describeTradeError } from '@/lib/trade';

export type Claimable = { stock: string; symbol: string; ticker: string; amount: number; amountRaw: string; usd: number | null };

/** Creator fees accrued in the hook, claimed in one transaction. */
export function ClaimFees({ wallet, claimable }: { wallet: string; claimable: Claimable[] }) {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const router = useRouter();
  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const deployment = publicEnv.deployment;
  const isOwner = address?.toLowerCase() === wallet.toLowerCase() && chainId === base.id;
  const totalUsd = claimable.reduce((sum, c) => sum + (c.usd ?? 0), 0);

  const claim = useMutation({
    mutationFn: async () => {
      if (!deployment || !client) throw new Error('Contracts are not configured.');
      const hash = await writeContractAsync({
        address: deployment.hook,
        abi: stockPairHookAbi,
        functionName: 'claimMany',
        args: [claimable.map((c) => c.stock as Address)],
        chainId: base.id,
        dataSuffix: builderDataSuffix(),
      });
      setTxHash(hash);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The claim reverted.');
      return hash;
    },
    onSuccess: () => router.refresh(),
  });

  if (claimable.length === 0) return <p className="px-4 py-4 text-[14px] text-ink-secondary">Nothing to claim right now. Fees accrue with every swap on tokens this wallet created.</p>;
  return (
    <div className="flex flex-col">
      {claimable.map((c) => (
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
        {totalUsd > 0 && (
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-ink-secondary">Total</span>
            <span className="display num text-[22px]">{formatUsd(totalUsd)}</span>
          </div>
        )}
        {isOwner ? (
          <Button full loading={claim.isPending} onClick={() => claim.mutate()}>
            Claim all
          </Button>
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
