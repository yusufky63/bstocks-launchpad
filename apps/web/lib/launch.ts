import { useCallback, useState } from 'react';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { quoteLaunchBuy, stockPairFactoryAbi, tokenIsCurrency0, type LaunchBuyQuote } from '@stockpair/core';

import { revertErrorName } from './revert';
import { describeTradeError, isUserRejection, minOutFor } from './trade';

/**
 * Buy at launch: share tiers. The contract has no cap (a second wallet one block later would get
 * around one); these are what this site shows and allows.
 */
export const DEV_BUY_NOTICE_BPS = 500;
export const DEV_BUY_CONFIRM_BPS = 1_500;
/** Owner decision: this site does not send a buy at launch of half the supply or more. */
export const DEV_BUY_BLOCK_BPS = 5_000;

export type DevBuyTier = 'none' | 'notice' | 'confirm' | 'blocked';

/** `notice` is amber, `confirm` is red with a required tick, `blocked` cannot be sent from here. */
export function devBuyTier(supplyBps: bigint | number): DevBuyTier {
  const bps = Number(supplyBps);
  if (bps >= DEV_BUY_BLOCK_BPS) return 'blocked';
  if (bps >= DEV_BUY_CONFIRM_BPS) return 'confirm';
  if (bps >= DEV_BUY_NOTICE_BPS) return 'notice';
  return 'none';
}

/**
 * Dev-buy tolerance, separate from trade slippage. Nobody can trade before the buy, so the only
 * thing it covers is the stock's Chainlink price moving before inclusion, which moves the output in
 * steps of about 0.995% per 100-tick bucket. A 1% default would revert on ordinary feed moves.
 */
export const DEV_TOLERANCE_DEFAULT_BPS = 200;
export const DEV_TOLERANCE_PRESETS_BPS = [100, 200, 300, 500] as const;
export const DEV_TOLERANCE_MIN_BPS = 50;
export const DEV_TOLERANCE_MAX_BPS = 500;

export function parseToleranceInput(text: string): { bps: number } | { error: string } {
  const error = { error: 'Enter 0.5% to 5%.' };
  const trimmed = text.trim().replace(/%$/u, '').trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/u.test(trimmed)) return error;
  const bps = Math.round(Number(trimmed) * 100);
  return bps >= DEV_TOLERANCE_MIN_BPS && bps <= DEV_TOLERANCE_MAX_BPS ? { bps } : error;
}

export function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * One salt per form session. The predicted address the creator reviews depends on it, so it must
 * not change between renders or after a failed attempt; only a successful launch uses it up.
 */
export function useLaunchSalt(): readonly [Hex, () => void] {
  const [salt, setSalt] = useState(randomSalt);
  const renew = useCallback(() => setSalt(randomSalt()), []);
  return [salt, renew] as const;
}

/** The creator's quote for a buy at launch: the exact replay in @stockpair/core, in the address order the factory uses. */
export function quoteDevBuy(a: { predicted: Address; stock: Address; openingTick: number; stockIn: bigint }): LaunchBuyQuote {
  return quoteLaunchBuy({ openingTick: a.openingTick, tokenIsCurrency0: tokenIsCurrency0(a.predicted, a.stock), stockIn: a.stockIn });
}

/**
 * The least `stockIn` that buys at least `bps` of the supply at this opening, found by bisection
 * over the exact quote, so the share tiers can be shown in money. A buy that would empty the pool
 * counts as reaching every share.
 */
export function stockInForShare(bps: number, at: { predicted: Address; stock: Address; openingTick: number }): bigint {
  const reaches = (stockIn: bigint) => {
    try {
      return quoteDevBuy({ ...at, stockIn }).supplyBps >= BigInt(bps);
    } catch {
      return true;
    }
  };
  let lo = 0n;
  let hi = 1n;
  while (!reaches(hi)) {
    lo = hi;
    hi *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (reaches(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The least the buy may return: the tolerance below the quote, and never 0 (the factory rejects 0). */
export function devBuyMinOut(tokensOut: bigint, toleranceBps: number = DEV_TOLERANCE_DEFAULT_BPS): bigint {
  const min = minOutFor(tokensOut, toleranceBps);
  return min < 1n ? 1n : min;
}

export type LaunchParamsArg = { name: string; symbol: string; contractURI: string; stock: Address; salt: Hex };
export type LaunchOptionsArg = { metadataEditable: boolean; openingFdvUsd8: bigint; deadline: bigint };
export type CreatorBuyArg = { stockIn: bigint; minTokensOut: bigint };

export type LaunchCall =
  | { functionName: 'launchWithOptions'; args: readonly [LaunchParamsArg, LaunchOptionsArg]; value: bigint }
  | { functionName: 'launchAndBuy'; args: readonly [LaunchParamsArg, LaunchOptionsArg, CreatorBuyArg]; value: bigint };

export interface LaunchCallInput {
  params: LaunchParamsArg;
  metadataEditable: boolean;
  /** The opening FDV the creator reviewed, frozen: the call reverts if the owner has changed it since. */
  reviewedFdv: bigint;
  deadline: bigint;
  creationFee: bigint;
  /** Null for no buy. `tokensOut` is the reviewed quote; the minimum is derived from it every time. */
  buy: { stockIn: bigint; tokensOut: bigint; toleranceBps?: number } | null;
}

/**
 * The factory call for a launch from this site: always one of the two entry points that take a
 * deadline and the FDV check. `msg.value` is the creation fee and nothing else.
 */
export function buildLaunchCall(input: LaunchCallInput): LaunchCall {
  const options: LaunchOptionsArg = { metadataEditable: input.metadataEditable, openingFdvUsd8: input.reviewedFdv, deadline: input.deadline };
  if (!input.buy) return { functionName: 'launchWithOptions', args: [input.params, options], value: input.creationFee };
  const buy: CreatorBuyArg = { stockIn: input.buy.stockIn, minTokensOut: devBuyMinOut(input.buy.tokensOut, input.buy.toleranceBps) };
  return { functionName: 'launchAndBuy', args: [input.params, options, buy], value: input.creationFee };
}

export function encodeLaunchCall(call: LaunchCall): Hex {
  return call.functionName === 'launchAndBuy'
    ? encodeFunctionData({ abi: stockPairFactoryAbi, functionName: 'launchAndBuy', args: call.args })
    : encodeFunctionData({ abi: stockPairFactoryAbi, functionName: 'launchWithOptions', args: call.args });
}

export type LaunchAbortReason = 'PriceMoved' | 'OpeningFdvChanged' | 'WrongCreationFee' | 'AccountChanged' | 'ShareLimit' | 'ShareUnconfirmed';

/** Stops raised by this app itself, before anything is sent, when the reviewed terms no longer hold. */
export class LaunchAbort extends Error {
  constructor(readonly reason: LaunchAbortReason) {
    super(reason);
    this.name = 'LaunchAbort';
  }
}

type Names = { stock: string; ticker: string };

const PAUSED = (n: Names) => `Launches against ${n.stock} are paused right now.`;

const LAUNCH_ERRORS: Record<string, (n: Names) => string> = {
  PriceMoved: () => 'The price moved since you reviewed. Review the new quote.',
  OpeningFdvChanged: () => 'The opening valuation changed after you reviewed. Nothing was launched. Review again.',
  Expired: () => 'Your launch expired before it was included. Nothing was launched.',
  TooLittleReceived: (n) => `${n.ticker}'s price moved and your buy would get fewer tokens than your minimum. Nothing was launched or spent. Review the new quote.`,
  WrongCreationFee: () => 'The creation fee changed. Refresh and review.',
  ZeroAmount: () => 'Enter an amount, or turn off Buy at launch.',
  InvalidText: () => 'The name, symbol or profile link was rejected. Editable profiles need an ipfs:// link to a bare CID, with no path.',
  StockNotEnabled: PAUSED,
  StaleFeed: PAUSED,
  InvalidFeed: PAUSED,
  UnexpectedRoles: () => 'The token was not created as expected. Nothing was launched. Please report this.',
  ContractPaused: (n) => `${n.stock} transfers are paused right now, so the buy cannot be made. Nothing was launched.`,
  PolicyForbids: (n) => `${n.stock}'s transfer rules do not allow this wallet to make the buy. Nothing was launched.`,
  AccountChanged: () => 'Your wallet or network changed since you reviewed. Nothing was sent. Review again.',
  ShareLimit: () => 'At the current price your buy would reach half the supply, which this site does not send. Nothing was launched. Review again with a smaller amount.',
  ShareUnconfirmed: () => 'At the current price your buy would be 15% of the supply or more. Nothing was launched. Review again and confirm the share.',
};

const ALLOWANCE_OR_BALANCE = (n: Names) => `The ${n.stock} approval or balance was not enough. Nothing was launched.`;
// OpenZeppelin names come from plain ERC-20s and the test mocks; the B20 stocks use their own.
const FUNDS_ERRORS = new Set(['ERC20InsufficientAllowance', 'ERC20InsufficientBalance', 'SafeERC20FailedOperation', 'InsufficientAllowance', 'InsufficientBalance']);

/** Reverts that mean the stock cannot take launches right now, whoever sends them. */
const PAUSED_ERRORS = new Set(['StockNotEnabled', 'StaleFeed', 'InvalidFeed']);

/** The paused copy when a read or a launch failed because the stock is closed to launches, else null. */
export function pausedReason(err: unknown, names: Names): string | null {
  const named = revertErrorName(err);
  return named && PAUSED_ERRORS.has(named) ? PAUSED(names) : null;
}

/**
 * Whether retrying the frozen plan cannot help: the terms it was reviewed on have moved (fee, FDV,
 * price, share tier, the stock's status) or the wallet changed. Those need a fresh review, not a retry.
 */
export function launchNeedsReview(err: unknown): boolean {
  if (err instanceof LaunchAbort) return true;
  const named = revertErrorName(err);
  return named !== null && (PAUSED_ERRORS.has(named) || ['OpeningFdvChanged', 'WrongCreationFee', 'TooLittleReceived'].includes(named));
}

/** One line for a failed launch, naming the paired stock and its ticker where it helps. */
export function describeLaunchError(err: unknown, names: Names): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (isUserRejection(raw)) return describeTradeError(err);
  if (err instanceof LaunchAbort) return LAUNCH_ERRORS[err.reason]!(names);
  const named = revertErrorName(err);
  if (named && LAUNCH_ERRORS[named]) return LAUNCH_ERRORS[named](names);
  if (named && FUNDS_ERRORS.has(named)) return ALLOWANCE_OR_BALANCE(names);
  // viem often decodes the name into the message itself; the table's keys are distinct words.
  for (const [name, copy] of Object.entries(LAUNCH_ERRORS)) {
    if (new RegExp(`\\b${name}\\b`, 'u').test(raw)) return copy(names);
  }
  if (/allowance|exceeds balance|insufficient balance|SafeERC20FailedOperation|TRANSFER_FROM_FAILED/iu.test(raw)) return ALLOWANCE_OR_BALANCE(names);
  return describeTradeError(err);
}
