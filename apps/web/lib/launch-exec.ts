import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from 'viem';
import { base } from 'viem/chains';

import { stockPairFactoryAbi } from '@stockpair/core';

import { attributionCapabilities, withAttribution } from './attribution';
import { txDeadline } from './deadline';
import { LaunchAbort, buildLaunchCall, devBuyMinOut, devBuyTier, encodeLaunchCall, quoteDevBuy } from './launch';
import { freshDeadline, simulateAfterApproval, walletIsAtomic } from './trade';

export type LaunchState = 'IDLE' | 'PINNING' | 'CHECKING' | 'APPROVAL' | 'REQUOTING' | 'AWAITING_WALLET' | 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED' | 'FAILED';

export const LAUNCH_BUSY: readonly LaunchState[] = ['PINNING', 'CHECKING', 'APPROVAL', 'REQUOTING', 'AWAITING_WALLET', 'SUBMITTED', 'CONFIRMING'];

/** Everything the creator reviewed, frozen. Nothing here is re-read to make the terms looser. */
export interface LaunchPlan {
  /**
   * The wallet and chain the review was read for. The token address is derived from the sender, and
   * the quote's currency order from that address, so the plan is only good for this account.
   */
  account: Address;
  chainId: number;
  factory: Address;
  stock: Address;
  name: string;
  symbol: string;
  salt: Hex;
  /** `predictToken(account, salt)`: the address the review showed, and the page opened afterwards. */
  predicted: Address;
  metadataEditable: boolean;
  reviewedFdv: bigint;
  creationFee: bigint;
  /** `shareAck`: the creator ticked the 15%-or-more box at review. */
  buy: { stockIn: bigint; tokensOut: bigint; toleranceBps: number; shareAck?: boolean } | null;
  /**
   * The newest factory predates `launchWithOptions` (it fails the capability read): launch with the
   * plain `launch(params)` it has, which means a fixed profile, no buy and no deadline.
   */
  legacy?: boolean;
}

export interface LaunchHooks {
  onState?: (state: LaunchState) => void;
  onApproval?: (hash: Hash) => void;
  onMode?: (mode: LaunchMode) => void;
  onSubmitted?: (hash: Hash | undefined) => void;
  /** The deadline actually signed into the launch, once it is known. Never called for a plain `launch`. */
  onDeadline?: (deadline: bigint) => void;
}

export type LaunchMode = 'single' | 'batched' | 'sequential';

export interface LaunchContext {
  account: Address;
  /** The chain the wallet is on now; checked against the reviewed one before anything happens. */
  chainId: number | undefined;
  walletClient: Pick<WalletClient, 'getCapabilities' | 'sendCalls' | 'waitForCallsStatus' | 'sendTransaction'>;
  publicClient: Pick<PublicClient, 'readContract' | 'getBlock' | 'call' | 'waitForTransactionReceipt' | 'simulateCalls'>;
}

export interface LaunchResult {
  txHash: Hash;
  token: Address;
  mode: LaunchMode;
}

type Call = { to: Address; data: Hex; value?: bigint };

/**
 * One pin per review. The form is frozen while the sheet is open, so a retry needs the same document,
 * and every pin spends a slot of the upload limit that profile edits share. A failed pin is not kept.
 */
export function pinOnce(pin: () => Promise<string>): () => Promise<string> {
  let pinned: Promise<string> | null = null;
  return () => {
    pinned ??= pin().catch((err: unknown) => {
      pinned = null;
      throw err;
    });
    return pinned;
  };
}

/**
 * Pin → (launchWithOptions | allowance → (batched approve + launchAndBuy | approve, re-quote,
 * launchAndBuy)) → receipt. Mirrors `executeSwap`: simulate before the wallet opens, build calldata
 * and its deadline last, and treat only a successful receipt as a launch.
 *
 * Every buy is re-quoted right before its calldata is built, on every path: the sheet can stay open
 * for minutes and an approval can take more. If the fresh quote no longer reaches the minimum the
 * creator reviewed, or now lands in a share tier the creator did not accept, nothing is sent; the
 * minimum itself is never lowered to make the launch go through.
 */
export async function executeLaunch(ctx: LaunchContext, plan: LaunchPlan, pin: () => Promise<string>, hooks: LaunchHooks = {}): Promise<LaunchResult> {
  const { account, walletClient, publicClient } = ctx;
  // A different sender lands the token at a different address than the one reviewed and opened afterwards.
  if (account.toLowerCase() !== plan.account.toLowerCase() || ctx.chainId !== plan.chainId) throw new LaunchAbort('AccountChanged');
  hooks.onState?.('PINNING');
  const contractURI = await pin();
  const params = { name: plan.name, symbol: plan.symbol, contractURI, stock: plan.stock, salt: plan.salt };
  const calldata = (deadline: bigint) => {
    const call = buildLaunchCall({
      params,
      metadataEditable: plan.metadataEditable,
      reviewedFdv: plan.reviewedFdv,
      deadline,
      creationFee: plan.creationFee,
      buy: plan.buy ? { stockIn: plan.buy.stockIn, tokensOut: plan.buy.tokensOut, toleranceBps: plan.buy.toleranceBps } : null,
    });
    return withAttribution(encodeLaunchCall(call));
  };
  const value = plan.creationFee;

  if (plan.legacy) {
    if (plan.buy || plan.metadataEditable) throw new Error('This factory cannot buy at launch or keep the profile editable.');
    hooks.onMode?.('single');
    hooks.onState?.('CHECKING');
    const data = withAttribution(encodeFunctionData({ abi: stockPairFactoryAbi, functionName: 'launch', args: [params] }));
    await simulateAfterApproval(publicClient, account, { to: plan.factory, data, value }, 0);
    const txHash = await send(ctx, { to: plan.factory, data, value }, hooks);
    return { txHash, token: plan.predicted, mode: 'single' };
  }

  if (!plan.buy) {
    hooks.onMode?.('single');
    hooks.onState?.('CHECKING');
    const deadline = await freshDeadline(publicClient);
    const data = calldata(deadline);
    await simulateAfterApproval(publicClient, account, { to: plan.factory, data, value }, 0);
    hooks.onDeadline?.(deadline);
    const txHash = await send(ctx, { to: plan.factory, data, value }, hooks);
    return { txHash, token: plan.predicted, mode: 'single' };
  }

  const buy = plan.buy;
  hooks.onState?.('CHECKING');
  const allowance = await publicClient.readContract({ address: plan.stock, abi: erc20Abi, functionName: 'allowance', args: [account, plan.factory] });
  const needsApproval = allowance < buy.stockIn;
  // Exactly the amount the buy spends: only this wallet's own launch can pull it, and none is left over.
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [plan.factory, buy.stockIn] });

  if (needsApproval && (await walletIsAtomic(walletClient, account))) {
    hooks.onMode?.('batched');
    // The same checks as after a sequential approval; they read only factory views, so they need no allowance.
    const deadline = await requote(publicClient, plan, hooks);
    const calls: Call[] = [
      { to: plan.stock, data: withAttribution(approveData) },
      { to: plan.factory, data: calldata(deadline), value },
    ];
    // The launch alone cannot be simulated before its approval exists, so the batch is simulated whole.
    await simulateBatch(publicClient, account, calls);
    hooks.onDeadline?.(deadline);
    hooks.onState?.('AWAITING_WALLET');
    const { id } = await walletClient.sendCalls({
      account,
      chain: base,
      forceAtomic: true,
      // Already attributed above; withAttribution is idempotent and keeps the guarantee at the send.
      calls: calls.map((call) => ({ ...call, data: withAttribution(call.data) })),
      capabilities: { ...attributionCapabilities() },
    });
    hooks.onState?.('SUBMITTED');
    hooks.onSubmitted?.(undefined);
    const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
    const hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
    if (result.status === 'failure' || !hash) return explainBatchFailure(publicClient, account, plan, calls);
    hooks.onState?.('CONFIRMING');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') return explainBatchFailure(publicClient, account, plan, calls);
    hooks.onState?.('CONFIRMED');
    return { txHash: hash, token: plan.predicted, mode: 'batched' };
  }

  hooks.onMode?.('sequential');
  if (needsApproval) {
    hooks.onState?.('APPROVAL');
    const approveHash = await walletClient.sendTransaction({ account, chain: base, to: plan.stock, data: withAttribution(approveData) });
    hooks.onApproval?.(approveHash);
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') throw new Error('The approval reverted. Nothing was launched.');
  }
  // After an approval that may have taken minutes, or straight away when the allowance was already there.
  const deadline = await requote(publicClient, plan, hooks);

  const data = calldata(deadline);
  await simulateAfterApproval(publicClient, account, { to: plan.factory, data, value }, needsApproval ? 4 : 0);
  hooks.onDeadline?.(deadline);
  const txHash = await send(ctx, { to: plan.factory, data, value }, hooks);
  return { txHash, token: plan.predicted, mode: 'sequential' };
}

/**
 * Reads the fee, the FDV, the opening and the latest block again, and stops if the reviewed terms
 * no longer hold: a lower output than the reviewed minimum, or a share of supply the creator was not
 * shown. Returns the deadline to sign, from that same block.
 */
async function requote(publicClient: LaunchContext['publicClient'], plan: LaunchPlan, hooks: LaunchHooks): Promise<bigint> {
  hooks.onState?.('REQUOTING');
  const buy = plan.buy!;
  const [fee, fdv, opening, block] = await Promise.all([
    publicClient.readContract({ address: plan.factory, abi: stockPairFactoryAbi, functionName: 'creationFee' }),
    publicClient.readContract({ address: plan.factory, abi: stockPairFactoryAbi, functionName: 'openingFdvUsd8' }),
    publicClient.readContract({ address: plan.factory, abi: stockPairFactoryAbi, functionName: 'previewOpening', args: [plan.stock, plan.predicted] }),
    publicClient.getBlock({ blockTag: 'latest' }),
  ]);
  if (fee !== plan.creationFee) throw new LaunchAbort('WrongCreationFee');
  if (fdv !== plan.reviewedFdv) throw new LaunchAbort('OpeningFdvChanged');
  const fresh = quoteDevBuy({ predicted: plan.predicted, stock: plan.stock, openingTick: Number(opening[1]), stockIn: buy.stockIn });
  if (fresh.tokensOut < devBuyMinOut(buy.tokensOut, buy.toleranceBps)) throw new LaunchAbort('PriceMoved');
  // The contract has no maximum: a stock price that rose since the review buys more of the supply,
  // so the share rules the review applied are applied again to what would be sent now.
  const tier = devBuyTier(fresh.supplyBps);
  if (tier === 'blocked') throw new LaunchAbort('ShareLimit');
  if (tier === 'confirm' && !buy.shareAck) throw new LaunchAbort('ShareUnconfirmed');
  return txDeadline(block.timestamp);
}

/**
 * Runs approve + launch as one simulated batch (eth_simulateV1) and throws the first revert. A node
 * that cannot simulate batches leaves only the re-read terms as the check, as before.
 */
async function simulateBatch(publicClient: LaunchContext['publicClient'], account: Address, calls: Call[]): Promise<void> {
  let results: readonly { status: string; error?: unknown }[];
  try {
    ({ results } = await publicClient.simulateCalls({ account, calls }));
  } catch {
    return;
  }
  const failed = results.find((r) => r.status === 'failure');
  if (failed) throw failed.error ?? new Error('The launch would revert. Nothing was sent.');
}

/**
 * A batch that failed onchain rolled back whole, approval included. Name the reason before offering a
 * retry: the terms that moved (a fresh review), or the revert the same batch hits now.
 */
async function explainBatchFailure(publicClient: LaunchContext['publicClient'], account: Address, plan: LaunchPlan, calls: Call[]): Promise<never> {
  await requote(publicClient, plan, {});
  await simulateBatch(publicClient, account, calls);
  throw new Error('The batched transaction did not succeed. Nothing was launched.');
}

async function send(ctx: LaunchContext, tx: { to: Address; data: Hex; value: bigint }, hooks: LaunchHooks): Promise<Hash> {
  hooks.onState?.('AWAITING_WALLET');
  // Already attributed by the caller; withAttribution is idempotent and keeps the guarantee local.
  const hash = await ctx.walletClient.sendTransaction({ account: ctx.account, chain: base, to: tx.to, data: withAttribution(tx.data), value: tx.value });
  hooks.onState?.('SUBMITTED');
  hooks.onSubmitted?.(hash);
  hooks.onState?.('CONFIRMING');
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The launch transaction reverted. Nothing was created.');
  hooks.onState?.('CONFIRMED');
  return hash;
}
