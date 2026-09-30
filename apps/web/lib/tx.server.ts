import 'server-only';

import { concatHex, encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from 'viem';

import { findStock, stockPairFactoryAbi, stockPairRouterAbi } from '@stockpair/core';
import type { Db } from '@stockpair/core/db';

import { partnerDataSuffix } from './attribution';
import { getPublicClient, serverDeployment, serverDeployments } from './chain.server';
import { txDeadline } from './deadline';
import { publicEnv } from './env';
import { buildLaunchCall, devBuyTier, encodeLaunchCall, quoteDevBuy, randomSalt, type DevBuyTier } from './launch';
import { DEFAULT_SLIPPAGE_BPS } from './limits';
import { quoteExactIn } from './quote.server';
import { revertErrorName } from './revert';
import { minOutFor } from './trade';

/**
 * Transactions another app can hand to its user's wallet: the same calls this site's own trade panel
 * and create form send, built from the same code, so an integration never re-implements the pool key,
 * the minimum output, the deadline or the launch quote.
 *
 * Nothing here signs or sends. The account named in a request is who will send the calls; a launch's
 * token address and a swap's allowance both depend on it, so the answer is good for that account only.
 * Approvals are for the exact amount, to the exact contract that spends it, as on the site.
 */

export type TxCall = { to: Address; data: Hex; value: string; description: 'approve' | 'swap' | 'launch' };

/**
 * `ok`: an eth_call of the final call succeeded now. `reverted`: it did not, with the error name when
 * it has one. `skipped`: an approval has to land first, and the call cannot be run before it.
 */
export type Simulation = { status: 'ok' } | { status: 'reverted'; error: string | null } | { status: 'skipped'; reason: 'approval' };

export class TxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const UINT128_MAX = (1n << 128n) - 1n;

function attributed(builderCode: string | undefined) {
  const suffix = partnerDataSuffix(builderCode);
  return (data: Hex): Hex => (suffix ? concatHex([data, suffix]) : data);
}

async function simulate(call: { account: Address; to: Address; data: Hex; value: bigint }): Promise<Simulation> {
  try {
    await getPublicClient().call(call);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'reverted', error: revertErrorName(err) };
  }
}

function expiry(deadline: bigint): string {
  return new Date(Number(deadline) * 1000).toISOString();
}

export type SwapTxRequest = {
  token: Address;
  side: 'buy' | 'sell';
  amountIn: bigint;
  /** Who sends the calls: pays the input and owns the allowance. */
  account: Address;
  /** Who receives the output; the account itself unless named. */
  recipient?: Address;
  slippageBps?: number;
  builderCode?: string;
};

export async function buildSwapTx(db: Db, req: SwapTxRequest) {
  if (req.amountIn <= 0n || req.amountIn > UINT128_MAX) throw new TxError(400, 'INVALID_AMOUNT', 'amountIn must be above zero and fit in a uint128.');
  // Throws QuoteError for an unknown token, a missing configuration or a pool that cannot fill it.
  const quote = await quoteExactIn(db, { token: req.token, side: req.side, amountIn: req.amountIn });

  // The router of the deployment that launched this token, found by the hook in its own pool key.
  const deployment = serverDeployments().find((d) => d.hook.toLowerCase() === quote.poolKey.hooks.toLowerCase());
  if (!deployment) throw new TxError(503, 'NOT_CONFIGURED', 'The router for this token is not configured.');
  // Lowercase like every other address the API returns; the env may hold them checksummed.
  const router = deployment.router.toLowerCase() as Address;
  const token = req.token.toLowerCase() as Address;
  const stock = (quote.poolKey.currency0.toLowerCase() === token ? quote.poolKey.currency1 : quote.poolKey.currency0).toLowerCase() as Address;
  const [tokenIn, tokenOut] = req.side === 'buy' ? [stock, token] : [token, stock];
  const recipient = req.recipient ?? req.account;
  const slippageBps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const minAmountOut = minOutFor(BigInt(quote.amountOut), slippageBps);

  const client = getPublicClient();
  const [allowance, block] = await Promise.all([
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [req.account, router] }),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  const deadline = txDeadline(block.timestamp);
  const attr = attributed(req.builderCode);
  const needsApproval = allowance < req.amountIn;

  const swap = attr(
    encodeFunctionData({ abi: stockPairRouterAbi, functionName: 'swapExactIn', args: [quote.poolKey, quote.zeroForOne, req.amountIn, minAmountOut, recipient, deadline] }),
  );
  const calls: TxCall[] = [];
  if (needsApproval) {
    calls.push({ to: tokenIn, data: attr(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, req.amountIn] })), value: '0', description: 'approve' });
  }
  calls.push({ to: router, data: swap, value: '0', description: 'swap' });

  const simulation: Simulation = needsApproval ? { status: 'skipped', reason: 'approval' } : await simulate({ account: req.account, to: router, data: swap, value: 0n });

  return {
    chainId: 8453,
    account: req.account,
    recipient,
    router,
    tokenIn,
    tokenOut,
    quote: {
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      minAmountOut: minAmountOut.toString(),
      slippageBps,
      feeBps: quote.feeBps,
      midPrice: quote.midPrice,
      executionPrice: quote.executionPrice,
      priceImpactPercent: quote.priceImpactPercent,
    },
    deadline: deadline.toString(),
    expiresAt: expiry(deadline),
    approval: needsApproval ? { token: tokenIn, spender: router, amount: req.amountIn.toString(), current: allowance.toString() } : null,
    calls,
    simulation,
  };
}

export type LaunchTxRequest = {
  /** Who sends the launch: the creator, who earns the creator's share. The token address depends on it. */
  account: Address;
  name: string;
  symbol: string;
  /** `ipfs://…`, as POST /api/metadata returns it. */
  contractURI: string;
  stock: Address;
  metadataEditable?: boolean;
  /** Keeps the token address stable across calls; a fresh random salt when absent. */
  salt?: Hex;
  buy?: { stockIn: bigint; toleranceBps: number; acknowledgeShare?: boolean };
  builderCode?: string;
};

export async function buildLaunchTx(req: LaunchTxRequest) {
  const deployment = serverDeployment();
  if (!deployment) throw new TxError(503, 'NOT_CONFIGURED', 'Launchpad contracts are not configured.');
  const factory = deployment.factory.toLowerCase() as Address;
  const stock = req.stock.toLowerCase() as Address;
  if (!findStock(stock)) throw new TxError(400, 'UNKNOWN_STOCK', 'That stock is not one of the stocks this launchpad pairs with.');
  const salt = req.salt ?? randomSalt();
  const client = getPublicClient();

  const [creationFee, openingFdvUsd8, predicted, info, hasOptions, block] = await Promise.all([
    client.readContract({ address: factory, abi: stockPairFactoryAbi, functionName: 'creationFee' }),
    client.readContract({ address: factory, abi: stockPairFactoryAbi, functionName: 'openingFdvUsd8' }),
    client.readContract({ address: factory, abi: stockPairFactoryAbi, functionName: 'predictToken', args: [req.account, salt] }),
    client.readContract({ address: factory, abi: stockPairFactoryAbi, functionName: 'stockInfo', args: [stock] }),
    // Only a factory with the launch options answers this; the site sends those or nothing.
    client
      .readContract({ address: factory, abi: stockPairFactoryAbi, functionName: 'metadataStatus', args: [zeroAddress] })
      .then(() => true)
      .catch(() => false),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  if (!info.enabled) throw new TxError(409, 'STOCK_NOT_ENABLED', `Launches against ${info.symbol || 'this stock'} are paused right now.`);
  if (!hasOptions) throw new TxError(503, 'FACTORY_UNSUPPORTED', 'The configured factory has no launchWithOptions.');
  const deadline = txDeadline(block.timestamp);

  let buy: { stockIn: bigint; tokensOut: bigint; toleranceBps: number } | null = null;
  let share: { supplyBps: string; tier: DevBuyTier } | null = null;
  let allowance: bigint | null = null;
  if (req.buy) {
    const opening = await client.readContract({ address: factory, abi: stockPairFactoryAbi, functionName: 'previewOpening', args: [stock, predicted] });
    let quote: ReturnType<typeof quoteDevBuy>;
    try {
      quote = quoteDevBuy({ predicted, stock, openingTick: Number(opening[1]), stockIn: req.buy.stockIn });
    } catch {
      throw new TxError(409, 'BUY_TOO_LARGE', 'That buy would take the whole launch position. Buy less.');
    }
    const tier = devBuyTier(quote.supplyBps);
    share = { supplyBps: quote.supplyBps.toString(), tier };
    // The contract has no cap; these are the limits this site sends under, and so does its API.
    if (tier === 'blocked') throw new TxError(409, 'SHARE_LIMIT', 'This buy would reach half the supply or more, which this launchpad does not send.', share);
    if (tier === 'confirm' && !req.buy.acknowledgeShare) {
      throw new TxError(409, 'SHARE_UNCONFIRMED', 'This buy is 15% of the supply or more. Show the share to the creator and send acknowledgeShare: true.', share);
    }
    buy = { stockIn: req.buy.stockIn, tokensOut: quote.tokensOut, toleranceBps: req.buy.toleranceBps };
    allowance = await client.readContract({ address: stock, abi: erc20Abi, functionName: 'allowance', args: [req.account, factory] });
  }

  const call = buildLaunchCall({
    params: { name: req.name, symbol: req.symbol, contractURI: req.contractURI, stock, salt },
    metadataEditable: req.metadataEditable ?? false,
    reviewedFdv: openingFdvUsd8,
    deadline,
    creationFee,
    buy,
  });
  const attr = attributed(req.builderCode);
  const launch = attr(encodeLaunchCall(call));
  const needsApproval = buy !== null && allowance !== null && allowance < buy.stockIn;
  const calls: TxCall[] = [];
  if (needsApproval && buy) {
    // Exactly what the buy spends: only this account's own launch can pull it, and none is left over.
    calls.push({ to: stock, data: attr(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [factory, buy.stockIn] })), value: '0', description: 'approve' });
  }
  calls.push({ to: factory, data: launch, value: creationFee.toString(), description: 'launch' });

  const simulation: Simulation = needsApproval ? { status: 'skipped', reason: 'approval' } : await simulate({ account: req.account, to: factory, data: launch, value: creationFee });
  const predictedToken = predicted.toLowerCase() as Address;

  return {
    chainId: 8453,
    account: req.account,
    factory,
    functionName: call.functionName,
    predictedToken,
    salt,
    creationFee: creationFee.toString(),
    openingFdvUsd8: openingFdvUsd8.toString(),
    metadataEditable: req.metadataEditable ?? false,
    buy:
      buy && share && call.functionName === 'launchAndBuy'
        ? { stockIn: buy.stockIn.toString(), tokensOut: buy.tokensOut.toString(), minTokensOut: call.args[2].minTokensOut.toString(), toleranceBps: buy.toleranceBps, supplyBps: share.supplyBps, shareTier: share.tier }
        : null,
    deadline: deadline.toString(),
    expiresAt: expiry(deadline),
    approval: needsApproval && buy ? { token: stock, spender: factory, amount: buy.stockIn.toString(), current: (allowance ?? 0n).toString() } : null,
    calls,
    simulation,
    tokenUrl: `${publicEnv.appUrl}/token/${predictedToken}`,
  };
}
