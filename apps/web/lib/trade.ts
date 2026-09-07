import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import { base } from 'viem/chains';

import { stockPairRouterAbi } from '@stockpair/core';

import { attributionCapabilities, withAttribution } from './attribution';
import type { QuoteView } from './types';

export type TradeState = 'IDLE' | 'CHECKING' | 'APPROVAL' | 'AWAITING_WALLET' | 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED' | 'FAILED';

export const BUSY_STATES: readonly TradeState[] = ['CHECKING', 'APPROVAL', 'AWAITING_WALLET', 'SUBMITTED', 'CONFIRMING'];

/** The least the swap may return: the quoted output minus the slippage tolerance. */
export function minOutFor(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

/** A deadline `seconds` from now, in unix seconds, as the router expects. */
export function deadlineIn(seconds: number, now = Date.now()): bigint {
  return BigInt(Math.floor(now / 1000) + seconds);
}

/** Preset share of a balance (25/50/75/100) in raw units. */
export function shareOf(balance: bigint, percent: number): bigint {
  const p = BigInt(Math.min(100, Math.max(0, Math.round(percent))));
  return (balance * p) / 100n;
}

/** Turns wallet and contract errors into one line a person can act on. */
export function describeTradeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split(/\r?\n/u)[0] ?? raw;
  if (/user rejected|user denied|rejected the request|denied transaction/iu.test(raw)) return 'You declined the request in your wallet. Nothing was sent.';
  if (/TooLittleReceived|slippage|amountOutMinimum|minAmountOut/iu.test(raw)) return 'The price moved more than your slippage tolerance. Nothing was swapped; try again or raise the tolerance.';
  if (/Expired|deadline/iu.test(raw)) return 'The transaction expired before it was mined. Nothing was swapped; try again.';
  if (/insufficient allowance|transfer amount exceeds allowance|STF|TRANSFER_FROM_FAILED/iu.test(raw)) return 'The router is not approved for this amount yet. Approve first, then swap.';
  if (/insufficient funds|exceeds balance|transfer amount exceeds/iu.test(raw)) return 'Not enough balance to cover the amount plus gas.';
  if (/chain|network/iu.test(raw) && /switch|mismatch|unsupported/iu.test(raw)) return 'Switch your wallet to Base, then try again.';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export interface SwapParams {
  quote: QuoteView;
  amountIn: bigint;
  minOut: bigint;
  inputToken: Address;
  router: Address;
  deadlineSeconds?: number;
}

export interface SwapHooks {
  onState?: (state: TradeState) => void;
  onApproval?: (hash: Hash) => void;
  onMode?: (mode: 'batched' | 'sequential') => void;
  onSubmitted?: (hash: Hash | undefined) => void;
}

export interface SwapResult {
  txHash: Hash;
  mode: 'batched' | 'sequential';
}

/**
 * Whether the wallet can take approve + swap as one atomic batch (EIP-5792). Base Account and
 * wallets upgraded under EIP-7702 answer yes; extensions without the method answer no.
 */
export async function walletIsAtomic(walletClient: WalletClient, account: Address): Promise<boolean> {
  try {
    const caps = (await walletClient.getCapabilities({ account, chainId: base.id })) as { atomic?: { status?: string } };
    return caps.atomic?.status === 'supported' || caps.atomic?.status === 'ready';
  } catch {
    return false;
  }
}

function swapCalldata(p: SwapParams, recipient: Address): Hex {
  return encodeFunctionData({
    abi: stockPairRouterAbi,
    functionName: 'swapExactIn',
    args: [p.quote.poolKey, p.quote.zeroForOne, p.amountIn, p.minOut, recipient, deadlineIn(p.deadlineSeconds ?? 180)],
  });
}

/**
 * Allowance → (batched approve + swap | sequential approve, simulate, swap) → receipt.
 * Simulation runs before the wallet opens so a revert is a message, not a lost gas fee. Straight
 * after our own approval a lagging RPC can still report the old allowance, so that one case is
 * retried a few times before it is treated as real.
 */
export async function executeSwap(
  ctx: { account: Address; walletClient: WalletClient; publicClient: PublicClient },
  params: SwapParams,
  hooks: SwapHooks = {},
): Promise<SwapResult> {
  const { account, walletClient, publicClient } = ctx;
  hooks.onState?.('CHECKING');
  const allowance = await publicClient.readContract({ address: params.inputToken, abi: erc20Abi, functionName: 'allowance', args: [account, params.router] });
  const needsApproval = allowance < params.amountIn;
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [params.router, params.amountIn] });
  const swapData = swapCalldata(params, account);

  if (needsApproval && (await walletIsAtomic(walletClient, account))) {
    hooks.onMode?.('batched');
    hooks.onState?.('AWAITING_WALLET');
    const { id } = await walletClient.sendCalls({
      account,
      chain: base,
      forceAtomic: true,
      calls: [
        { to: params.inputToken, data: withAttribution(approveData) },
        { to: params.router, data: withAttribution(swapData) },
      ],
      capabilities: { ...attributionCapabilities() },
    });
    hooks.onState?.('SUBMITTED');
    hooks.onSubmitted?.(undefined);
    const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
    const hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
    if (result.status === 'failure' || !hash) throw new Error('The batched transaction did not succeed. Nothing was swapped.');
    hooks.onState?.('CONFIRMING');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The swap reverted onchain.');
    hooks.onState?.('CONFIRMED');
    return { txHash: hash, mode: 'batched' };
  }

  hooks.onMode?.('sequential');
  if (needsApproval) {
    hooks.onState?.('APPROVAL');
    const approveHash = await walletClient.sendTransaction({ account, chain: base, to: params.inputToken, data: withAttribution(approveData) });
    hooks.onApproval?.(approveHash);
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') throw new Error('The approval reverted.');
  }

  // Simulate exactly what gets sent, suffix included.
  await simulateAfterApproval(publicClient, account, { to: params.router, data: withAttribution(swapData) }, needsApproval ? 4 : 0);

  hooks.onState?.('AWAITING_WALLET');
  const hash = await walletClient.sendTransaction({ account, chain: base, to: params.router, data: withAttribution(swapData) });
  hooks.onState?.('SUBMITTED');
  hooks.onSubmitted?.(hash);
  hooks.onState?.('CONFIRMING');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The swap reverted onchain.');
  hooks.onState?.('CONFIRMED');
  return { txHash: hash, mode: 'sequential' };
}

async function simulateAfterApproval(publicClient: PublicClient, account: Address, call: { to: Address; data: Hex }, retries: number): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await publicClient.call({ account, to: call.to, data: call.data });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const staleAllowance = /allowance|STF|TRANSFER_FROM_FAILED|reverted/iu.test(msg);
      if (staleAllowance && i < retries) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
}
