import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import { base } from 'viem/chains';

import { stockPairRouterAbi } from '@stockpair/core';

import { attributionCapabilities, withAttribution } from './attribution';
import { txDeadline } from './deadline';
import { revertErrorName } from './revert';
import type { QuoteView } from './types';

export type TradeState = 'IDLE' | 'CHECKING' | 'APPROVAL' | 'AWAITING_WALLET' | 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED' | 'FAILED';

export const BUSY_STATES: readonly TradeState[] = ['CHECKING', 'APPROVAL', 'AWAITING_WALLET', 'SUBMITTED', 'CONFIRMING'];

/** The least the swap may return: the quoted output minus the slippage tolerance. */
export function minOutFor(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

/** Preset share of a balance (25/50/75/100) in raw units. */
export function shareOf(balance: bigint, percent: number): bigint {
  const p = BigInt(Math.min(100, Math.max(0, Math.round(percent))));
  return (balance * p) / 100n;
}

const DECLINED = 'You declined the request in your wallet. Nothing was sent.';
const SLIPPAGE = 'The price moved more than your slippage tolerance. Nothing was swapped; try again or raise the tolerance.';
const EXPIRED = 'The transaction expired before it was mined. Nothing was swapped; try again.';
const NOT_APPROVED = 'The contract is not approved for this amount yet.';
const NO_BALANCE = 'Not enough balance to cover the amount plus gas.';
const PARTIAL = 'The pool could not fill the whole amount. Nothing was swapped; try a smaller amount.';
const PAUSED = 'Transfers of this token or its stock are paused right now. Nothing was swapped.';
const POLICY = "The stock's transfer rules do not allow this wallet to make this swap. Nothing was swapped.";

/** Custom errors by name, decoded from the revert data (v4's WrappedError unwrapped first). */
const TRADE_ERRORS: Record<string, string> = {
  PartialFill: PARTIAL,
  TooLittleReceived: SLIPPAGE,
  Expired: EXPIRED,
  ERC20InsufficientAllowance: NOT_APPROVED,
  SafeERC20FailedOperation: NOT_APPROVED,
  ERC20InsufficientBalance: NO_BALANCE,
  // B20 tokens (the stocks and every token launched here) revert with these instead.
  InsufficientAllowance: NOT_APPROVED,
  InsufficientBalance: NO_BALANCE,
  ContractPaused: PAUSED,
  PolicyForbids: POLICY,
};

export function isUserRejection(raw: string): boolean {
  return /user rejected|user denied|rejected the request|denied transaction/iu.test(raw);
}

/** Turns wallet and contract errors into one line a person can act on. */
export function describeTradeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split(/\r?\n/u)[0] ?? raw;
  if (isUserRejection(raw)) return DECLINED;
  const named = revertErrorName(err);
  if (named && TRADE_ERRORS[named]) return TRADE_ERRORS[named];
  if (/PartialFill/u.test(raw)) return PARTIAL;
  if (/TooLittleReceived|slippage|amountOutMinimum|minAmountOut/iu.test(raw)) return SLIPPAGE;
  if (/Expired|deadline/iu.test(raw)) return EXPIRED;
  if (/insufficient allowance|transfer amount exceeds allowance|STF|TRANSFER_FROM_FAILED/iu.test(raw)) return NOT_APPROVED;
  if (/insufficient funds|exceeds balance|transfer amount exceeds/iu.test(raw)) return NO_BALANCE;
  if (/chain|network/iu.test(raw) && /switch|mismatch|unsupported/iu.test(raw)) return 'Switch your wallet to Base, then try again.';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export interface SwapParams {
  quote: QuoteView;
  amountIn: bigint;
  minOut: bigint;
  inputToken: Address;
  router: Address;
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
export async function walletIsAtomic(walletClient: Pick<WalletClient, 'getCapabilities'>, account: Address): Promise<boolean> {
  try {
    const caps = (await walletClient.getCapabilities({ account, chainId: base.id })) as { atomic?: { status?: string } };
    return caps.atomic?.status === 'supported' || caps.atomic?.status === 'ready';
  } catch {
    return false;
  }
}

function swapCalldata(p: SwapParams, recipient: Address, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: stockPairRouterAbi,
    functionName: 'swapExactIn',
    args: [p.quote.poolKey, p.quote.zeroForOne, p.amountIn, p.minOut, recipient, deadline],
  });
}

/** Ten minutes from the later of the latest block and this device's clock, read right now. */
export async function freshDeadline(publicClient: Pick<PublicClient, 'getBlock'>, nowMs = Date.now()): Promise<bigint> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  return txDeadline(block.timestamp, nowMs);
}

/**
 * Allowance → (batched approve + swap | sequential approve, simulate, swap) → receipt.
 * Simulation runs before the wallet opens so a revert is a message, not a lost gas fee. Straight
 * after our own approval a lagging RPC can still report the old allowance, so that one case is
 * retried a few times before it is treated as real.
 *
 * The swap calldata, and so its deadline, is built only once nothing else is left to wait for:
 * after the approval's receipt, or just before the batch goes to the wallet. Building it first let
 * a slow approval eat the deadline before the swap was even signed.
 */
export async function executeSwap(
  ctx: {
    account: Address;
    walletClient: Pick<WalletClient, 'getCapabilities' | 'sendCalls' | 'waitForCallsStatus' | 'sendTransaction'>;
    publicClient: Pick<PublicClient, 'readContract' | 'getBlock' | 'call' | 'waitForTransactionReceipt'>;
  },
  params: SwapParams,
  hooks: SwapHooks = {},
): Promise<SwapResult> {
  const { account, walletClient, publicClient } = ctx;
  hooks.onState?.('CHECKING');
  const allowance = await publicClient.readContract({ address: params.inputToken, abi: erc20Abi, functionName: 'allowance', args: [account, params.router] });
  const needsApproval = allowance < params.amountIn;
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [params.router, params.amountIn] });

  if (needsApproval && (await walletIsAtomic(walletClient, account))) {
    hooks.onMode?.('batched');
    const swapData = swapCalldata(params, account, await freshDeadline(publicClient));
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

  const swapData = swapCalldata(params, account, await freshDeadline(publicClient));
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

export async function simulateAfterApproval(
  publicClient: Pick<PublicClient, 'call'>,
  account: Address,
  call: { to: Address; data: Hex; value?: bigint },
  retries: number,
  delayMs = 1200,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await publicClient.call({ account, to: call.to, data: call.data, ...(call.value ? { value: call.value } : {}) });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const staleAllowance = /allowance|STF|TRANSFER_FROM_FAILED|reverted/iu.test(msg);
      if (staleAllowance && i < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}
