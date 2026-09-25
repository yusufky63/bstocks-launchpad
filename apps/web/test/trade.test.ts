import { BaseError, RawContractError, concat, decodeFunctionData, encodeAbiParameters, encodeErrorResult, toFunctionSelector, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { stockPairFactoryAbi, stockPairHookAbi, stockPairRouterAbi } from '@stockpair/core';

import { getBuilderDataSuffix } from '@/lib/attribution';
import { describeLaunchError } from '@/lib/launch';
import { findRevertData, revertErrorName, wrappedErrorAbi } from '@/lib/revert';
import { describeTradeError, executeSwap } from '@/lib/trade';
import type { QuoteView } from '@/lib/types';

const ROUTER = '0x7007000000000000000000000000000000000001' as Address;
const STOCK = '0xb20000000000000000000078ee7ce2fe4908108c' as Address;
const HOOK = '0x4000000000000000000000000000000000000ccc' as Address;
const ACCOUNT = '0xc0ffee0000000000000000000000000000000001' as Address;

const quote: QuoteView = {
  amountIn: '100000000',
  amountOut: '5000000000000000000000',
  side: 'buy',
  feeBps: 100,
  midPrice: 1,
  executionPrice: 1,
  priceImpactPercent: 0.5,
  poolKey: { currency0: '0x1111111111111111111111111111111111111111', currency1: STOCK, fee: 0, tickSpacing: 100, hooks: HOOK },
  zeroForOne: false,
  gasEstimate: '1',
  liquidity: '1',
};

function strip(data: Hex): Hex {
  const suffix = getBuilderDataSuffix();
  return suffix && data.endsWith(suffix.slice(2)) ? (data.slice(0, data.length - (suffix.length - 2)) as Hex) : data;
}

/** Stand-ins for the viem clients that record the order things happen in. */
function fakeClients(opts: { allowance: bigint; atomic: boolean }) {
  const events: string[] = [];
  const sent: { to: Address; data: Hex }[] = [];
  const batches: { calls: { to: Address; data: Hex }[] }[] = [];
  let block = 9_000_000_000n;
  const publicClient = {
    readContract: async () => {
      events.push('read:allowance');
      return opts.allowance;
    },
    getBlock: async () => {
      block += 7n;
      events.push(`block:${block}`);
      return { timestamp: block };
    },
    call: async () => {
      events.push('simulate');
      return { data: '0x' };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      events.push(`receipt:${hash}`);
      return { status: 'success' };
    },
  };
  const walletClient = {
    getCapabilities: async () => (opts.atomic ? { atomic: { status: 'ready' } } : {}),
    sendCalls: async (args: { calls: { to: Address; data: Hex }[] }) => {
      events.push('sendCalls');
      batches.push(args);
      return { id: 'b' };
    },
    waitForCallsStatus: async () => ({ status: 'success', receipts: [{ transactionHash: '0xbb' }] }),
    sendTransaction: async (tx: { to: Address; data: Hex }) => {
      sent.push(tx);
      const hash = tx.to === STOCK ? '0xa1' : '0x5a';
      events.push(`send:${hash}`);
      return hash;
    },
  };
  return { ctx: { account: ACCOUNT, walletClient, publicClient } as never, events, sent, batches };
}

const deadlineOf = (data: Hex): bigint => {
  const decoded = decodeFunctionData({ abi: stockPairRouterAbi, data: strip(data) });
  expect(decoded.functionName).toBe('swapExactIn');
  return (decoded.args as readonly unknown[])[5] as bigint;
};

describe('executeSwap', () => {
  const params = { quote, amountIn: 100_000_000n, minOut: 1n, inputToken: STOCK, router: ROUTER };

  it('builds the swap calldata only after the approval receipt, with a ten-minute deadline from then', async () => {
    const f = fakeClients({ allowance: 0n, atomic: false });
    await executeSwap(f.ctx, params);
    expect(f.sent.map((t) => t.to)).toEqual([STOCK, ROUTER]);
    const approvalReceipt = f.events.indexOf('receipt:0xa1');
    const blocks = f.events.filter((e) => e.startsWith('block:'));
    expect(blocks).toHaveLength(1);
    expect(f.events.indexOf(blocks[0]!)).toBeGreaterThan(approvalReceipt);
    expect(f.events.indexOf('simulate')).toBeGreaterThan(f.events.indexOf(blocks[0]!));
    expect(deadlineOf(f.sent[1]!.data)).toBe(BigInt(blocks[0]!.slice(6)) + 600n);
  });

  it('builds the batched swap just before the batch goes to the wallet', async () => {
    const f = fakeClients({ allowance: 0n, atomic: true });
    const result = await executeSwap(f.ctx, params);
    expect(result.mode).toBe('batched');
    const blocks = f.events.filter((e) => e.startsWith('block:'));
    expect(f.events.indexOf(blocks.at(-1)!)).toBe(f.events.indexOf('sendCalls') - 1);
    expect(deadlineOf(f.batches[0]!.calls[1]!.data)).toBe(BigInt(blocks.at(-1)!.slice(6)) + 600n);
  });

  it('with enough allowance goes straight to the swap, still with a fresh deadline', async () => {
    const f = fakeClients({ allowance: 10n ** 18n, atomic: true });
    await executeSwap(f.ctx, params);
    expect(f.sent.map((t) => t.to)).toEqual([ROUTER]);
    expect(deadlineOf(f.sent[0]!.data)).toBe(9_000_000_007n + 600n);
  });
});

describe('revert decoding', () => {
  const partialFill = encodeErrorResult({ abi: stockPairHookAbi, errorName: 'PartialFill' });
  const afterSwap = toFunctionSelector('afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)');
  const wrapped = encodeErrorResult({ abi: wrappedErrorAbi, errorName: 'WrappedError', args: [HOOK, afterSwap, partialFill, '0x'] });

  it('knows the v4 WrappedError and PartialFill selectors', () => {
    expect(wrapped.slice(0, 10)).toBe('0x90bfb865');
    expect(partialFill).toBe('0xd964f528');
  });

  it('unwraps WrappedError to the hook reason, wherever viem keeps the data', () => {
    expect(revertErrorName(new BaseError('reverted', { cause: new RawContractError({ data: wrapped }) }))).toBe('PartialFill');
    expect(revertErrorName({ cause: { raw: wrapped } })).toBe('PartialFill');
    expect(revertErrorName({ cause: { data: { data: wrapped } } })).toBe('PartialFill');
    expect(findRevertData(new Error('no data'))).toBeNull();
  });

  it('describes a partial fill in plain words', () => {
    const err = new BaseError('The contract function "swapExactIn" reverted with the following signature: 0x90bfb865', { cause: new RawContractError({ data: wrapped }) });
    expect(describeTradeError(err)).toBe('The pool could not fill the whole amount. Nothing was swapped; try a smaller amount.');
  });

  it('says the contract, not the router, needs approving', () => {
    expect(describeTradeError(new Error('ERC20: insufficient allowance'))).toBe('The contract is not approved for this amount yet.');
    const router = new BaseError('reverted', { cause: new RawContractError({ data: encodeErrorResult({ abi: stockPairRouterAbi, errorName: 'TooLittleReceived' }) }) });
    expect(describeTradeError(router)).toMatch(/slippage tolerance/u);
  });
});

describe('describeLaunchError', () => {
  const names = { stock: 'NVDAc', ticker: 'NVDA' };
  const reverted = (errorName: string, abi: readonly unknown[] = stockPairFactoryAbi, args?: readonly unknown[]) =>
    new BaseError('Execution reverted.', { cause: new RawContractError({ data: encodeErrorResult({ abi, errorName, args } as never) }) });

  it('maps every launch error to its line', () => {
    const table: [string, string][] = [
      ['OpeningFdvChanged', 'The opening valuation changed after you reviewed. Nothing was launched. Review again.'],
      ['Expired', 'Your launch expired before it was included. Nothing was launched.'],
      ['TooLittleReceived', "NVDA's price moved and your buy would get fewer tokens than your minimum. Nothing was launched or spent. Review the new quote."],
      ['WrongCreationFee', 'The creation fee changed. Refresh and review.'],
      ['ZeroAmount', 'Enter an amount, or turn off Buy at launch.'],
      ['InvalidText', 'The name, symbol or profile link was rejected. Editable profiles need an ipfs:// link to a bare CID, with no path.'],
      ['StockNotEnabled', 'Launches against NVDAc are paused right now.'],
      ['StaleFeed', 'Launches against NVDAc are paused right now.'],
      ['UnexpectedRoles', 'The token was not created as expected. Nothing was launched. Please report this.'],
    ];
    for (const [errorName, message] of table) {
      expect(describeLaunchError(reverted(errorName), names), errorName).toBe(message);
      // Also when viem already decoded the name into the message and kept no data.
      expect(describeLaunchError(new Error(`The contract function "launchAndBuy" reverted.\n\nError: ${errorName}()`), names), errorName).toBe(message);
    }
  });

  it('maps allowance and balance failures to one line', () => {
    const funds = 'The NVDAc approval or balance was not enough. Nothing was launched.';
    const abi = [
      { type: 'error', name: 'ERC20InsufficientAllowance', inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'allowance' }, { type: 'uint256', name: 'needed' }] },
      { type: 'error', name: 'ERC20InsufficientBalance', inputs: [{ type: 'address', name: 'sender' }, { type: 'uint256', name: 'balance' }, { type: 'uint256', name: 'needed' }] },
    ];
    expect(describeLaunchError(reverted('ERC20InsufficientAllowance', abi, [ROUTER, 0n, 1n]), names)).toBe(funds);
    expect(describeLaunchError(reverted('ERC20InsufficientBalance', abi, [ACCOUNT, 0n, 1n]), names)).toBe(funds);
    expect(describeLaunchError(reverted('SafeERC20FailedOperation', stockPairFactoryAbi, [STOCK]), names)).toBe(funds);
    expect(describeLaunchError(new Error('ERC20: transfer amount exceeds allowance'), names)).toBe(funds);
  });

  it('keeps wallet refusals and unknown failures readable', () => {
    expect(describeLaunchError(new Error('User rejected the request.'), names)).toMatch(/declined/u);
    expect(describeLaunchError(new Error('something odd'), names)).toBe('something odd');
  });

  it('says a feed that cannot be used pauses launches, like a disabled stock', () => {
    expect(describeLaunchError(reverted('InvalidFeed'), names)).toBe('Launches against NVDAc are paused right now.');
  });
});

/**
 * The stocks and every launched token are B20 precompile tokens, which revert with IB20's own
 * errors, not OpenZeppelin's. Built from the signatures in base-std, with the selectors a mainnet
 * NVDAc call returns, so this does not lean on the app's own ABI to agree with itself.
 */
describe('B20 token errors', () => {
  const names = { stock: 'NVDAc', ticker: 'NVDA' };
  const b20 = (signature: string, types: readonly { type: string }[], values: readonly unknown[]) =>
    new BaseError('Execution reverted for an unknown reason.', {
      cause: new RawContractError({ data: concat([toFunctionSelector(signature), encodeAbiParameters(types, values as never)]) }),
    });
  const allowance = b20('InsufficientAllowance(address,uint256,uint256)', [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [ROUTER, 0n, 1n]);
  const balance = b20('InsufficientBalance(address,uint256,uint256)', [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [ACCOUNT, 0n, 1n]);
  const paused = b20('ContractPaused(uint8)', [{ type: 'uint8' }], [1]);
  const policy = b20('PolicyForbids(bytes32,uint64)', [{ type: 'bytes32' }, { type: 'uint64' }], [`0x${'00'.repeat(32)}`, 7n]);

  it('uses the selectors the precompile reverts with', () => {
    expect(toFunctionSelector('InsufficientAllowance(address,uint256,uint256)')).toBe('0x192b9e4e');
    expect(toFunctionSelector('InsufficientBalance(address,uint256,uint256)')).toBe('0xdb42144d');
    expect(toFunctionSelector('ContractPaused(uint8)')).toBe('0xfd8c4245');
    expect(toFunctionSelector('PolicyForbids(bytes32,uint64)')).toBe('0xa43fec12');
    expect([allowance, balance, paused, policy].map(revertErrorName)).toEqual(['InsufficientAllowance', 'InsufficientBalance', 'ContractPaused', 'PolicyForbids']);
  });

  it('maps a B20 allowance or balance failure in a launch to the funds line', () => {
    const funds = 'The NVDAc approval or balance was not enough. Nothing was launched.';
    expect(describeLaunchError(allowance, names)).toBe(funds);
    expect(describeLaunchError(balance, names)).toBe(funds);
    expect(describeLaunchError(paused, names)).toBe('NVDAc transfers are paused right now, so the buy cannot be made. Nothing was launched.');
    expect(describeLaunchError(policy, names)).toBe("NVDAc's transfer rules do not allow this wallet to make the buy. Nothing was launched.");
  });

  it('maps the same failures in a trade', () => {
    expect(describeTradeError(allowance)).toBe('The contract is not approved for this amount yet.');
    expect(describeTradeError(balance)).toBe('Not enough balance to cover the amount plus gas.');
    expect(describeTradeError(paused)).toBe('Transfers of this token or its stock are paused right now. Nothing was swapped.');
    expect(describeTradeError(policy)).toBe("The stock's transfer rules do not allow this wallet to make this swap. Nothing was swapped.");
  });
});
