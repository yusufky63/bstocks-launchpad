import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import { BASE_STOCKS } from '@stockpair/core';
import type { Db } from '@stockpair/core/db';

const mocks = vi.hoisted(() => ({
  readMarket: vi.fn(),
  readLaunch: vi.fn(),
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  deployment: {
    factory: '0x1111111111111111111111111111111111111111',
    hook: '0x2222222222222222222222222222222222222222',
    router: '0x3333333333333333333333333333333333333333',
    deployBlock: 1n,
  },
}));

vi.mock('@stockpair/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stockpair/core/db')>()),
  readMarket: mocks.readMarket,
}));
vi.mock('@/lib/onchain.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onchain.server')>()),
  readLaunchOnchain: mocks.readLaunch,
}));
vi.mock('@/lib/chain.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chain.server')>()),
  serverDeployments: () => [mocks.deployment],
  getPublicClient: () => ({ readContract: mocks.readContract, simulateContract: mocks.simulateContract }),
}));

import { poolIdFor, poolKeyFor, quoteExactIn } from '@/lib/quote.server';

const token = '0xb2000000000000000000000000000000000000aa' as Address;
const stock = BASE_STOCKS[0]!.address;
const key = poolKeyFor(token, stock, mocks.deployment.hook as Address);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readMarket.mockResolvedValue(null);
  mocks.readLaunch.mockResolvedValue({
    token, stock, factory: mocks.deployment.factory, hook: mocks.deployment.hook,
    creator: '0x4444444444444444444444444444444444444444',
    name: 'Fresh token', symbol: 'FRESH', contractURI: '', launchedAt: new Date().toISOString(),
    openingSqrtPriceX96: (1n << 96n).toString(), stockUsd8: '100000000',
  });
  mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'poolKeyOf') return key;
    if (functionName === 'getSlot0') return [1n << 96n, 0, 0, 0];
    if (functionName === 'getLiquidity') return 1000n;
    if (functionName === 'currentFeeBps') return 100n;
    throw new Error('unexpected onchain read');
  });
  mocks.simulateContract.mockResolvedValue({ result: [1n * 10n ** 18n, 200_000n] });
});

describe('trading before indexing', () => {
  it('quotes a confirmed launch from its live pool when no market row exists', async () => {
    const quote = await quoteExactIn({} as Db, { token, side: 'buy', amountIn: 100_000_000n });
    expect(quote).toMatchObject({
      amountIn: '100000000', amountOut: '1000000000000000000',
      side: 'buy', feeBps: 100, poolKey: key, liquidity: '1000',
    });
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getSlot0', args: [poolIdFor(key)],
    }));
    expect(mocks.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'quoteExactInputSingle',
      args: [expect.objectContaining({ poolKey: key, exactAmount: 100_000_000n })],
    }));
  });

  it('refuses to quote if the factory reports a different pool key', async () => {
    mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'poolKeyOf') return { ...key, hooks: '0x5555555555555555555555555555555555555555' };
      throw new Error('no other read expected');
    });
    await expect(quoteExactIn({} as Db, { token, side: 'buy', amountIn: 100_000_000n }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(mocks.simulateContract).not.toHaveBeenCalled();
  });
});
