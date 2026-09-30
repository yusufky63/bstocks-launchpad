import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { Attribution } from 'ox/erc8021';

import { BASE_STOCKS, stockPairFactoryAbi, stockPairRouterAbi } from '@stockpair/core';
import type { Db } from '@stockpair/core/db';

const mocks = vi.hoisted(() => ({
  readMarket: vi.fn(),
  readLaunch: vi.fn(),
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  call: vi.fn(),
  getBlock: vi.fn(),
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
  serverDeployment: () => mocks.deployment,
  getPublicClient: () => ({ readContract: mocks.readContract, simulateContract: mocks.simulateContract, call: mocks.call, getBlock: mocks.getBlock }),
}));

import { POST as postLaunchTx } from '@/app/api/tx/launch/route';
import { POST as postSwapTx } from '@/app/api/tx/swap/route';
import { getBuilderDataSuffix, partnerDataSuffix } from '@/lib/attribution';
import { setDbForTests } from '@/lib/db.server';
import { devBuyMinOut, quoteDevBuy, stockInForShare } from '@/lib/launch';
import { poolKeyFor } from '@/lib/quote.server';
import { API_LIMITS, resetRateLimits } from '@/lib/rate-limit.server';
import { TxError, buildLaunchTx, buildSwapTx } from '@/lib/tx.server';

const TOKEN = '0xb2000000000000000000000000000000000000aa' as Address;
const STOCK = BASE_STOCKS[0]!.address.toLowerCase() as Address;
const ACCOUNT = '0xc0ffee0000000000000000000000000000000001' as Address;
const OTHER = '0xc0ffee0000000000000000000000000000000002' as Address;
/** Sorts below the stock, so the launched token is currency0, as in the launch-quote vectors. */
const PREDICTED = '0x1111111111111111111111111111111111111112' as Address;
const KEY = poolKeyFor(TOKEN, STOCK, mocks.deployment.hook as Address);
const BLOCK_TS = 1_900_000_000n;
const FEE = 100_000_000_000_000n;
const FDV = 500_000_000_000n;
const TICK = -450_355;
const AMOUNT_OUT = 1_000n * 10n ** 18n;

let allowance = 0n;
let stockEnabled = true;
let hasOptions = true;

/** Decoded calldata names addresses checksummed; the API speaks lowercase. */
function lower<T>(value: T): T {
  if (typeof value === 'string') return (/^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() : value) as T;
  if (Array.isArray(value)) return value.map(lower) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lower(v)])) as T;
  return value;
}

/** The suffix this site appends; stripped so the call can be decoded as the contract reads it. */
function strip(data: Hex, suffix: Hex | null = getBuilderDataSuffix()): Hex {
  expect(suffix, 'a builder code is configured').not.toBeNull();
  expect(data.endsWith(suffix!.slice(2))).toBe(true);
  return data.slice(0, data.length - (suffix!.length - 2)) as Hex;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  setDbForTests({} as Db);
  allowance = 0n;
  stockEnabled = true;
  hasOptions = true;
  mocks.readMarket.mockResolvedValue(null);
  mocks.readLaunch.mockResolvedValue({
    token: TOKEN, stock: STOCK, factory: mocks.deployment.factory, hook: mocks.deployment.hook,
    creator: '0x4444444444444444444444444444444444444444', name: 'Fresh', symbol: 'FRESH', contractURI: '',
    launchedAt: new Date().toISOString(), openingSqrtPriceX96: (1n << 96n).toString(), stockUsd8: '23000000000',
  });
  mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'poolKeyOf': return KEY;
      case 'getSlot0': return [1n << 96n, 0, 0, 0];
      case 'getLiquidity': return 1000n;
      case 'currentFeeBps': return 100n;
      case 'allowance': return allowance;
      case 'creationFee': return FEE;
      case 'openingFdvUsd8': return FDV;
      case 'predictToken': return PREDICTED;
      case 'stockInfo': return { feed: '0x5555555555555555555555555555555555555555', enabled: stockEnabled, decimals: 8, symbol: 'NVDAc' };
      case 'metadataStatus':
        if (!hasOptions) throw new Error('execution reverted');
        return 0;
      case 'previewOpening': return [0n, TICK, 23_000_000_000n];
      default: throw new Error(`unexpected read ${functionName}`);
    }
  });
  mocks.simulateContract.mockResolvedValue({ result: [AMOUNT_OUT, 200_000n] });
  mocks.getBlock.mockResolvedValue({ timestamp: BLOCK_TS });
  mocks.call.mockResolvedValue({ data: '0x' });
});

describe('swap transactions', () => {
  it('approves exactly the input for the token router, then swaps with the site minimum and deadline', async () => {
    const tx = await buildSwapTx({} as Db, { token: TOKEN, side: 'buy', amountIn: 100_000_000n, account: ACCOUNT, slippageBps: 200 });
    expect(tx).toMatchObject({ chainId: 8453, router: mocks.deployment.router, tokenIn: STOCK, tokenOut: TOKEN, recipient: ACCOUNT });
    expect(tx.quote.minAmountOut).toBe(((AMOUNT_OUT * 9_800n) / 10_000n).toString());
    expect(BigInt(tx.deadline)).toBeGreaterThanOrEqual(BLOCK_TS + 600n);
    expect(tx.calls.map((c) => c.description)).toEqual(['approve', 'swap']);
    expect(tx.approval).toEqual({ token: STOCK, spender: mocks.deployment.router, amount: '100000000', current: '0' });

    const approve = decodeFunctionData({ abi: erc20Abi, data: strip(tx.calls[0]!.data) });
    expect(approve.functionName).toBe('approve');
    expect(lower(approve.args)).toEqual([mocks.deployment.router, 100_000_000n]);
    expect(tx.calls[0]!.to).toBe(STOCK);

    const swap = decodeFunctionData({ abi: stockPairRouterAbi, data: strip(tx.calls[1]!.data) });
    expect(swap.functionName).toBe('swapExactIn');
    expect(lower(swap.args)).toEqual([KEY, KEY.currency0 === STOCK, 100_000_000n, (AMOUNT_OUT * 9_800n) / 10_000n, ACCOUNT, BigInt(tx.deadline)]);
    expect(tx.calls[1]!.to).toBe(mocks.deployment.router);
    // The swap cannot be run before the approval exists.
    expect(tx.simulation).toEqual({ status: 'skipped', reason: 'approval' });
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('skips the approval when the allowance covers it, and simulates the swap', async () => {
    allowance = 100_000_000n;
    const tx = await buildSwapTx({} as Db, { token: TOKEN, side: 'buy', amountIn: 100_000_000n, account: ACCOUNT });
    expect(tx.calls.map((c) => c.description)).toEqual(['swap']);
    expect(tx.approval).toBeNull();
    expect(tx.quote.slippageBps).toBe(100);
    expect(tx.simulation).toEqual({ status: 'ok' });
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT, to: mocks.deployment.router }));
  });

  it('reports a swap that would revert instead of hiding it', async () => {
    allowance = 10n ** 30n;
    mocks.call.mockRejectedValue(new Error('execution reverted'));
    const tx = await buildSwapTx({} as Db, { token: TOKEN, side: 'sell', amountIn: 10n ** 18n, account: ACCOUNT });
    expect(tx.tokenIn).toBe(TOKEN);
    expect(tx.simulation.status).toBe('reverted');
  });

  it('pays another recipient when asked, and carries a partner builder code beside the site one', async () => {
    const tx = await buildSwapTx({} as Db, { token: TOKEN, side: 'buy', amountIn: 5n, account: ACCOUNT, recipient: OTHER, builderCode: 'bc_partner1' });
    const suffix = partnerDataSuffix('bc_partner1');
    expect(suffix).toBe(Attribution.toDataSuffix({ codes: [getBuilderSiteCode(), 'bc_partner1'] }));
    for (const call of tx.calls) expect(call.data.endsWith(suffix!.slice(2))).toBe(true);
    const swap = decodeFunctionData({ abi: stockPairRouterAbi, data: strip(tx.calls[1]!.data, suffix) });
    expect(lower(swap.args[4])).toBe(OTHER);
  });

  it('refuses an amount a uint128 cannot hold', async () => {
    await expect(buildSwapTx({} as Db, { token: TOKEN, side: 'buy', amountIn: 1n << 128n, account: ACCOUNT })).rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
  });
});

/** The site's own code, read the way partnerDataSuffix reads it. */
function getBuilderSiteCode(): string {
  return process.env.NEXT_PUBLIC_BASE_BUILDER_CODE || 'bc_71vd6x2w';
}

const launchInput = { account: ACCOUNT, name: 'Test', symbol: 'TEST', contractURI: 'ipfs://bafytest', stock: STOCK };

describe('launch transactions', () => {
  it('builds launchWithOptions with the fee as value and the FDV and deadline the factory checks', async () => {
    const tx = await buildLaunchTx({ ...launchInput, salt: `0x${'ab'.repeat(32)}` });
    expect(tx).toMatchObject({ functionName: 'launchWithOptions', predictedToken: PREDICTED.toLowerCase(), creationFee: FEE.toString(), openingFdvUsd8: FDV.toString(), buy: null, approval: null });
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]).toMatchObject({ to: mocks.deployment.factory, value: FEE.toString(), description: 'launch' });
    const call = decodeFunctionData({ abi: stockPairFactoryAbi, data: strip(tx.calls[0]!.data) });
    expect(call.functionName).toBe('launchWithOptions');
    expect(lower(call.args)).toEqual([
      { name: 'Test', symbol: 'TEST', contractURI: 'ipfs://bafytest', stock: STOCK, salt: `0x${'ab'.repeat(32)}` },
      { metadataEditable: false, openingFdvUsd8: FDV, deadline: BigInt(tx.deadline) },
    ]);
    expect(tx.simulation).toEqual({ status: 'ok' });
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT, to: mocks.deployment.factory, value: FEE }));
    expect(tx.tokenUrl).toMatch(new RegExp(`/token/${PREDICTED.toLowerCase()}$`, 'u'));
  });

  it('picks a fresh salt when none is given, so every call names its own token address', async () => {
    const tx = await buildLaunchTx(launchInput);
    expect(tx.salt).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'predictToken', args: [ACCOUNT, tx.salt] }));
  });

  it('approves exactly the buy for the factory and sets the minimum from the exact launch quote', async () => {
    const stockIn = 10n ** 6n;
    const tx = await buildLaunchTx({ ...launchInput, buy: { stockIn, toleranceBps: 300 } });
    const quote = quoteDevBuy({ predicted: PREDICTED, stock: STOCK, openingTick: TICK, stockIn });
    expect(tx.functionName).toBe('launchAndBuy');
    expect(tx.buy).toMatchObject({ stockIn: stockIn.toString(), tokensOut: quote.tokensOut.toString(), minTokensOut: devBuyMinOut(quote.tokensOut, 300).toString(), toleranceBps: 300, shareTier: 'none' });
    expect(tx.calls.map((c) => c.description)).toEqual(['approve', 'launch']);
    const approve = decodeFunctionData({ abi: erc20Abi, data: strip(tx.calls[0]!.data) });
    expect(lower(approve.args)).toEqual([mocks.deployment.factory, stockIn]);
    expect(tx.calls[0]!.to).toBe(STOCK);
    const call = decodeFunctionData({ abi: stockPairFactoryAbi, data: strip(tx.calls[1]!.data) });
    expect(call.args[2]).toEqual({ stockIn, minTokensOut: devBuyMinOut(quote.tokensOut, 300) });
    expect(tx.simulation).toEqual({ status: 'skipped', reason: 'approval' });
  });

  it('keeps to the site share rules: 15% needs an acknowledgement, 50% is never sent', async () => {
    const at = { predicted: PREDICTED, stock: STOCK, openingTick: TICK };
    const large = stockInForShare(2_000, at);
    await expect(buildLaunchTx({ ...launchInput, buy: { stockIn: large, toleranceBps: 200 } })).rejects.toMatchObject({ status: 409, code: 'SHARE_UNCONFIRMED' });
    const ok = await buildLaunchTx({ ...launchInput, buy: { stockIn: large, toleranceBps: 200, acknowledgeShare: true } });
    expect(ok.buy?.shareTier).toBe('confirm');
    const half = stockInForShare(5_000, at);
    await expect(buildLaunchTx({ ...launchInput, buy: { stockIn: half, toleranceBps: 200, acknowledgeShare: true } })).rejects.toMatchObject({ status: 409, code: 'SHARE_LIMIT' });
  });

  it('refuses a paused stock, an unknown one, and a factory without the launch options', async () => {
    stockEnabled = false;
    await expect(buildLaunchTx(launchInput)).rejects.toMatchObject({ status: 409, code: 'STOCK_NOT_ENABLED' });
    stockEnabled = true;
    await expect(buildLaunchTx({ ...launchInput, stock: OTHER })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_STOCK' });
    hasOptions = false;
    await expect(buildLaunchTx(launchInput)).rejects.toBeInstanceOf(TxError);
  });
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://launchpad.basestocks.finance/api/tx', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('POST /api/tx/swap and /api/tx/launch', () => {
  it('returns the calls as JSON strings, bigints included', async () => {
    const res = await postSwapTx(post({ token: TOKEN, side: 'buy', amountIn: '100000000', account: ACCOUNT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls[1].to).toBe(mocks.deployment.router);
    expect(typeof body.deadline).toBe('string');
  });

  it('refuses a body the builders cannot trust', async () => {
    for (const bad of [
      { token: TOKEN, side: 'buy', amountIn: '1', account: 'nope' },
      { token: TOKEN, side: 'hold', amountIn: '1', account: ACCOUNT },
      { token: TOKEN, side: 'buy', amountIn: '1', account: ACCOUNT, slippageBps: 900 },
      { token: TOKEN, side: 'buy', amountIn: '1', account: ACCOUNT, builderCode: 'has,comma' },
    ]) {
      expect((await postSwapTx(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    for (const bad of [
      { ...launchInput, symbol: 'lower' },
      { ...launchInput, name: '' },
      { ...launchInput, contractURI: 'https://example.com/meta.json' },
      // An editable profile needs a bare CID from the start: no path.
      { ...launchInput, contractURI: 'ipfs://bafy/../x', metadataEditable: true },
      { ...launchInput, buy: { stockIn: '1', toleranceBps: 900 } },
    ]) {
      expect((await postLaunchTx(post(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.readContract).not.toHaveBeenCalled();
  });

  it('passes a builder error on with its status and details', async () => {
    stockEnabled = false;
    const res = await postLaunchTx(post(launchInput));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('STOCK_NOT_ENABLED');
  });

  it('limits one caller to a few dozen builds a minute', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < API_LIMITS.tx; i += 1) expect((await postSwapTx(post({}, headers))).status).toBe(400);
    const refused = await postLaunchTx(post({}, headers));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    // Another caller is unaffected.
    expect((await postSwapTx(post({}, { 'x-forwarded-for': '203.0.113.10' }))).status).toBe(400);
  });
});
