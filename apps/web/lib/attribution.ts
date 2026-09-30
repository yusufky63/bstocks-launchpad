import { Attribution } from 'ox/erc8021';
import { concatHex, type Hex } from 'viem';

import { publicEnv } from './env';

/**
 * Base Builder Codes (ERC-8021).
 *
 * Every transaction this app originates carries a suffix that attributes the activity to the
 * builder code. The suffix is trailing calldata the target contract never reads, so appending it
 * cannot change what a call does. Kept in one place so a new send site cannot quietly ship
 * unattributed.
 *
 * Docs: https://docs.base.org/specifications/builder-codes/for-app-developers
 */
let cachedSuffix: Hex | null | undefined;

export function getBuilderDataSuffix(): Hex | null {
  if (cachedSuffix !== undefined) return cachedSuffix;
  const code = publicEnv.builderCode.trim();
  if (!code) {
    cachedSuffix = null;
    return null;
  }
  try {
    cachedSuffix = Attribution.toDataSuffix({ codes: [code] });
  } catch {
    cachedSuffix = null;
  }
  return cachedSuffix;
}

/** A builder code as the suffix can carry it: codes are joined with commas, so none may contain one. */
export const BUILDER_CODE = /^[A-Za-z0-9_-]{2,32}$/u;

/**
 * This site's code plus another app's, for a transaction that app builds through the API: both show
 * up as attributed in one ERC-8021 suffix. A code that is not a valid one is left out, never escaped.
 */
export function partnerDataSuffix(partnerCode?: string | null): Hex | null {
  const codes = [publicEnv.builderCode.trim(), partnerCode?.trim() ?? '']
    .filter((code) => BUILDER_CODE.test(code))
    .filter((code, i, all) => all.indexOf(code) === i);
  return codes.length > 0 ? Attribution.toDataSuffix({ codes }) : null;
}

/** The suffix in the shape viem's writeContract/sendTransaction takes, or undefined when unset. */
export function builderDataSuffix(): Hex | undefined {
  return getBuilderDataSuffix() ?? undefined;
}

/** Appends the suffix to calldata built by hand. Idempotent. */
export function withAttribution(data: Hex): Hex {
  const suffix = getBuilderDataSuffix();
  if (!suffix) return data;
  if (data.toLowerCase().endsWith(suffix.slice(2).toLowerCase())) return data;
  return concatHex([data, suffix]);
}

export function isAttributionEnabled(): boolean {
  return getBuilderDataSuffix() !== null;
}

/**
 * EIP-5792 batches: a smart wallet wraps the calls in a UserOperation and indexers read the suffix
 * at the end of that outer callData, not the inner calls. The `dataSuffix` capability asks the
 * wallet to put it there; `optional: true` keeps wallets that do not support it working.
 */
export function attributionCapabilities(): { dataSuffix: { value: Hex; optional: true } } | Record<string, never> {
  const suffix = getBuilderDataSuffix();
  return suffix ? { dataSuffix: { value: suffix, optional: true } } : {};
}
