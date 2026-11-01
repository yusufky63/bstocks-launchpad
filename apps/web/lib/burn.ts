import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { base } from 'viem/chains';

import { decodeTransfer, type RawLog } from '@stockpair/core';

import { withAttribution } from './attribution';
import { supplyPercent } from './market-view';
import { isUserRejection } from './trade';
import type { BurnView } from './types';

/**
 * Where a burn sends tokens. Nobody holds this address's key, so whatever arrives stays there. The
 * tokens launched here have no burn function anyone may call (no admin, no burn role), which is why
 * a burn is a transfer: the token contract's total supply stays the same, and the launchpad counts
 * what sits here as burned.
 */
export const BURN_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';

export type BurnState = 'IDLE' | 'AWAITING_WALLET' | 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED' | 'FAILED';

export const BURN_BUSY: readonly BurnState[] = ['AWAITING_WALLET', 'SUBMITTED', 'CONFIRMING'];

/** `transfer(0x…dEaD, amount)` on the token. */
export function burnCalldata(amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BURN_ADDRESS, amount] });
}

/**
 * Simulate, send from the holder's wallet, and wait for the receipt before saying anything burned.
 * The simulation is what turns "you do not hold that many" into a message instead of a lost fee.
 */
export async function executeBurn(
  ctx: {
    account: Address;
    walletClient: Pick<WalletClient, 'sendTransaction'>;
    publicClient: Pick<PublicClient, 'call' | 'waitForTransactionReceipt'>;
  },
  params: { token: Address; amount: bigint },
  hooks: { onState?: (state: BurnState) => void; onSubmitted?: (hash: Hash) => void } = {},
): Promise<{ txHash: Hash; receipt: TransactionReceipt }> {
  if (params.amount <= 0n) throw new Error('Enter an amount to burn.');
  const calldata = burnCalldata(params.amount);
  // Simulate exactly what gets sent, suffix included.
  await ctx.publicClient.call({ account: ctx.account, to: params.token, data: withAttribution(calldata) });
  hooks.onState?.('AWAITING_WALLET');
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account, chain: base, to: params.token, data: withAttribution(calldata) });
  hooks.onSubmitted?.(hash);
  hooks.onState?.('SUBMITTED');
  hooks.onState?.('CONFIRMING');
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The burn reverted onchain. Nothing was burned.');
  return { txHash: hash, receipt };
}

export function describeBurnError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split(/\r?\n/u)[0] ?? raw;
  if (isUserRejection(raw)) return 'You declined the request in your wallet. Nothing was burned.';
  if (/insufficient funds/iu.test(raw)) return 'This wallet does not have enough ETH on Base for the gas.';
  if (/exceeds balance|insufficient balance|transfer amount exceeds/iu.test(raw)) return 'This wallet does not hold that many tokens.';
  if (/chain|network/iu.test(raw) && /switch|mismatch|unsupported/iu.test(raw)) return 'Switch your wallet to Base, then try again.';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export type BurnMarket = { token: string; name: string; symbol: string; imageUrl: string | null; creator: string; priceUsd: number | null };

/**
 * The burns in a mined receipt: this token's transfers to the burn address, as the burns API would
 * list them. The burner is the transfer's sender, which is what the indexer records. Valued at the
 * token's current price, which is its last trade before the burn: a burn does not move the price.
 */
export function burnsFromReceipt(receipt: { blockNumber: bigint; logs: readonly RawLog[] }, market: BurnMarket, blockTime: Date): BurnView[] {
  const token = market.token.toLowerCase();
  return receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== token || log.transactionHash === null || log.logIndex === null) return [];
    const transfer = decodeTransfer(log);
    if (!transfer || transfer.to.toLowerCase() !== BURN_ADDRESS.toLowerCase() || transfer.value === 0n) return [];
    const amount = Number(transfer.value) / 1e18;
    const burner = transfer.from.toLowerCase();
    return [
      {
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        token,
        name: market.name,
        symbol: market.symbol,
        imageUrl: market.imageUrl,
        burner,
        isCreator: burner === market.creator.toLowerCase(),
        amount,
        amountRaw: transfer.value.toString(),
        supplyPercent: supplyPercent(transfer.value),
        valueUsd: market.priceUsd === null ? null : amount * market.priceUsd,
        blockNumber: receipt.blockNumber.toString(),
        blockTime: blockTime.toISOString(),
      },
    ];
  });
}
