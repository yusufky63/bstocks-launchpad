import { decodeErrorResult, erc20Abi, parseAbi, type Abi, type Hex } from 'viem';

import { stockPairFactoryAbi, stockPairHookAbi, stockPairRouterAbi } from '@stockpair/core';

/**
 * v4-core wraps a revert from a hook callback as WrappedError(hook, selector, reason, details), so a
 * hook error such as PartialFill reaches the caller one level down, inside `reason`.
 */
export const wrappedErrorAbi = parseAbi(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);

/** OpenZeppelin ERC-20 errors: what the contract tests' mock stocks revert with, and any plain ERC-20. */
const erc20ErrorAbi = parseAbi([
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
]);

/**
 * The B20 precompile's own errors (IB20 in base-std). The Coinbase stocks and every token launched
 * here are B20 tokens, so a real allowance, balance, pause or policy failure arrives as one of these,
 * passed through SafeERC20 and the PoolManager unchanged.
 */
export const b20ErrorAbi = parseAbi([
  'error InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ContractPaused(uint8 feature)',
  'error PolicyForbids(bytes32 policyScope, uint64 policyId)',
  'error InvalidSender(address sender)',
  'error InvalidReceiver(address receiver)',
]);

/** Every custom error a launch, a swap or a claim here can end in. */
export const knownErrorsAbi = [
  ...wrappedErrorAbi,
  ...stockPairFactoryAbi,
  ...stockPairHookAbi,
  ...stockPairRouterAbi,
  ...erc20ErrorAbi,
  ...b20ErrorAbi,
  ...erc20Abi,
].filter((item) => item.type === 'error') as Abi;

const isRevertHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,}$/u.test(v);

/**
 * The raw revert data behind a viem or wallet error, if any layer carries it. viem keeps it on
 * `raw` (ContractFunctionRevertedError) or `data` (RawContractError), several causes deep.
 */
export function findRevertData(err: unknown): Hex | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 12; depth++) {
    const e = current as { raw?: unknown; data?: unknown; cause?: unknown };
    if (isRevertHex(e.raw)) return e.raw;
    if (isRevertHex(e.data)) return e.data;
    if (e.data && typeof e.data === 'object' && isRevertHex((e.data as { data?: unknown }).data)) return (e.data as { data: Hex }).data;
    current = e.cause;
  }
  return null;
}

/**
 * The name of the custom error an error ends in, unwrapping v4's WrappedError to the hook's own
 * reason. Falls back to a name viem already decoded into the message. Null when nothing matches.
 */
export function revertErrorName(err: unknown): string | null {
  const data = findRevertData(err);
  if (data) {
    const name = decodeName(data);
    if (name) return name;
  }
  const walked = namedCause(err);
  if (walked) return walked;
  return null;
}

function decodeName(data: Hex, depth = 0): string | null {
  try {
    const decoded = decodeErrorResult({ abi: knownErrorsAbi, data });
    if (decoded.errorName === 'WrappedError' && depth < 3) {
      const reason = (decoded.args as readonly unknown[])[2];
      if (isRevertHex(reason)) return decodeName(reason, depth + 1) ?? 'WrappedError';
      return 'WrappedError';
    }
    return decoded.errorName;
  } catch {
    return null;
  }
}

/** viem's ContractFunctionRevertedError carries `errorName` once it decoded the revert itself. */
function namedCause(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 12; depth++) {
    const e = current as { errorName?: unknown; data?: { errorName?: unknown }; cause?: unknown };
    if (typeof e.errorName === 'string' && e.errorName) return e.errorName;
    if (e.data && typeof e.data === 'object' && typeof e.data.errorName === 'string') return e.data.errorName;
    current = e.cause;
  }
  return null;
}
