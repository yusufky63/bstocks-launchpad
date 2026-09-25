import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { RawContractError, decodeFunctionData, encodeErrorResult, erc20Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { BASE_STOCKS, quoteLaunchBuy, stockPairFactoryAbi } from '@stockpair/core';

import { getBuilderDataSuffix } from '@/lib/attribution';
import {
  DEV_BUY_BLOCK_BPS,
  DEV_TOLERANCE_DEFAULT_BPS,
  LaunchAbort,
  buildLaunchCall,
  describeLaunchError,
  devBuyMinOut,
  devBuyTier,
  encodeLaunchCall,
  launchNeedsReview,
  parseToleranceInput,
  pausedReason,
  quoteDevBuy,
  randomSalt,
  stockInForShare,
  useLaunchSalt,
} from '@/lib/launch';
import { executeLaunch, pinOnce, type LaunchPlan, type LaunchState } from '@/lib/launch-exec';

const STOCK = BASE_STOCKS[0]!.address as Address; // NVDAc, 0xb200…
/** Sorts below the stock, so the token is currency0, as in the vector row used below. */
const PREDICTED = '0x1111111111111111111111111111111111111111' as Address;
const FACTORY = '0xfac7000000000000000000000000000000000001' as Address;
const ACCOUNT = '0xc0ffee0000000000000000000000000000000001' as Address;
const SALT = `0x${'ab'.repeat(32)}` as Hex;
const TICK = -450_355;
const FEE = 1_000_000_000_000_000n;
const FDV = 500_000_000_000n;
/** 0.01 NVDAc: a small share, where a 300-tick feed move shifts the output by about 3%. */
const BUY_IN = 10n ** 6n;

const params = { name: 'Test', symbol: 'TEST', contractURI: 'ipfs://bafytest', stock: STOCK, salt: SALT };

/** The attribution suffix is trailing calldata; strip it to decode what the factory reads. */
function decodeLaunch(data: Hex) {
  const suffix = getBuilderDataSuffix();
  const body = suffix && data.endsWith(suffix.slice(2)) ? (data.slice(0, data.length - (suffix.length - 2)) as Hex) : data;
  return decodeFunctionData({ abi: stockPairFactoryAbi, data: body });
}

describe('buildLaunchCall', () => {
  it('uses launchWithOptions without a buy and launchAndBuy with one', () => {
    const off = buildLaunchCall({ params, metadataEditable: false, reviewedFdv: FDV, deadline: 123n, creationFee: FEE, buy: null });
    expect(off.functionName).toBe('launchWithOptions');
    const on = buildLaunchCall({ params, metadataEditable: true, reviewedFdv: FDV, deadline: 123n, creationFee: FEE, buy: { stockIn: BUY_IN, tokensOut: 1_000_000n } });
    expect(on.functionName).toBe('launchAndBuy');
  });

  it('always sends the creation fee as value and the reviewed FDV and deadline as options', () => {
    for (const buy of [null, { stockIn: 5n, tokensOut: 100n }]) {
      const call = buildLaunchCall({ params, metadataEditable: true, reviewedFdv: FDV, deadline: 999n, creationFee: FEE, buy });
      expect(call.value).toBe(FEE);
      expect(call.args[1]).toEqual({ metadataEditable: true, openingFdvUsd8: FDV, deadline: 999n });
      expect(call.args[0]).toEqual(params);
    }
  });

  it('sets the minimum 2% below the quote by default, never below 1', () => {
    const call = buildLaunchCall({ params, metadataEditable: false, reviewedFdv: FDV, deadline: 1n, creationFee: FEE, buy: { stockIn: 7n, tokensOut: 1_000_000n } });
    expect(call.functionName === 'launchAndBuy' && call.args[2]).toEqual({ stockIn: 7n, minTokensOut: 980_000n });
    expect(DEV_TOLERANCE_DEFAULT_BPS).toBe(200);
    expect(devBuyMinOut(1n)).toBe(1n);
    expect(devBuyMinOut(0n)).toBe(1n);
    expect(devBuyMinOut(1_000n, 500)).toBe(950n);
  });

  it('encodes calldata the factory ABI decodes back to the same call', () => {
    const call = buildLaunchCall({ params, metadataEditable: false, reviewedFdv: FDV, deadline: 42n, creationFee: FEE, buy: { stockIn: 3n, tokensOut: 50n } });
    const decoded = decodeFunctionData({ abi: stockPairFactoryAbi, data: encodeLaunchCall(call) });
    expect(decoded.functionName).toBe('launchAndBuy');
    expect(decoded.args?.[2]).toEqual({ stockIn: 3n, minTokensOut: 49n });
  });
});

describe('dev buy tiers and tolerance', () => {
  it('draws the tier lines at 5%, 15% and 50% of supply', () => {
    expect([499, 500, 1_499, 1_500, 4_999, 5_000].map(devBuyTier)).toEqual(['none', 'notice', 'notice', 'confirm', 'confirm', 'blocked']);
    expect(devBuyTier(10_000n)).toBe('blocked');
    expect(DEV_BUY_BLOCK_BPS).toBe(5_000);
  });

  it('accepts a custom tolerance of 0.5% to 5% only', () => {
    expect(parseToleranceInput('0.5')).toEqual({ bps: 50 });
    expect(parseToleranceInput('2')).toEqual({ bps: 200 });
    expect(parseToleranceInput('5%')).toEqual({ bps: 500 });
    for (const text of ['0.49', '5.01', '', 'two', '10']) expect(parseToleranceInput(text), text).toEqual({ error: 'Enter 0.5% to 5%.' });
  });
});

describe('the launch quote', () => {
  const vector = readFileSync(fileURLToPath(new URL('../../../packages/contracts/test/vectors/launch-buy.jsonl', import.meta.url)), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tick: number; tokenIsCurrency0: boolean; stockIn: string; tokensOut: string })
    .find((row) => row.tokenIsCurrency0 && row.tick === TICK)!;

  it('is the core replay, ordered by the predicted address against the stock', () => {
    const quote = quoteDevBuy({ predicted: PREDICTED, stock: STOCK, openingTick: vector.tick, stockIn: BigInt(vector.stockIn) });
    expect(quote.tokensOut).toBe(BigInt(vector.tokensOut));
    expect(quote).toEqual(quoteLaunchBuy({ openingTick: vector.tick, tokenIsCurrency0: true, stockIn: BigInt(vector.stockIn) }));
  });

  it('finds the least spend that reaches a share of supply', () => {
    const at = { predicted: PREDICTED, stock: STOCK, openingTick: TICK };
    for (const bps of [500, 1_500, 5_000]) {
      const stockIn = stockInForShare(bps, at);
      expect(quoteDevBuy({ ...at, stockIn }).supplyBps).toBeGreaterThanOrEqual(BigInt(bps));
      expect(quoteDevBuy({ ...at, stockIn: stockIn - 1n }).supplyBps).toBeLessThan(BigInt(bps));
    }
  });
});

describe('the launch salt', () => {
  it('is created once per form session and survives re-renders', () => {
    const seen: Hex[] = [];
    function Form() {
      const [salt] = useLaunchSalt();
      const [renders, setRenders] = useState(0);
      seen.push(salt);
      // A render-phase update re-runs this component with its state kept, as a re-render does.
      if (renders < 4) setRenders(renders + 1);
      return null;
    }
    renderToString(createElement(Form));
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it('changes only when renewed, then holds the new value', () => {
    const seen: Hex[] = [];
    function Form() {
      const [salt, renew] = useLaunchSalt();
      const [step, setStep] = useState(0);
      seen.push(salt);
      if (step === 1) renew();
      if (step < 3) setStep(step + 1);
      return null;
    }
    renderToString(createElement(Form));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[1]);
    expect(seen.at(-1)).toBe(seen[2]);
  });

  it('is renewed by the create form only after a launch landed', () => {
    const source = readFileSync(fileURLToPath(new URL('../components/create/create-form.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('useLaunchSalt()');
    expect(source).not.toMatch(/randomSalt\(/u);
    const renewals = [...source.matchAll(/renewSalt\(\)/gu)];
    expect(renewals).toHaveLength(1);
    expect(source.slice(source.indexOf('onLaunched='), renewals[0]!.index)).not.toContain('onClose');
    expect(randomSalt()).not.toBe(randomSalt());
  });
});

/** Stand-ins for the viem clients that record the order things happen in. */
function fakeClients(opts: {
  allowance?: bigint;
  atomic?: boolean;
  tickAfterApproval?: number;
  feeAfterApproval?: bigint;
  fdvAfterApproval?: bigint;
  /** What every read returns from the start: the terms moved while the sheet was open. */
  tick?: number;
  fdv?: bigint;
  /** eth_simulateV1: per-call results, or 'unsupported' for a node without it. */
  simulate?: 'unsupported' | { status: 'success' | 'failure'; error?: unknown }[];
  /** What the same batch simulates to once it has been sent, for a batch that then failed onchain. */
  simulateAfterSend?: { status: 'success' | 'failure'; error?: unknown }[];
  batchStatus?: 'success' | 'failure';
  chainId?: number;
  account?: Address;
}) {
  const events: string[] = [];
  const sent: { to: Address; data: Hex; value?: bigint }[] = [];
  const batches: { calls: { to: Address; data: Hex; value?: bigint }[] }[] = [];
  const simulated: { calls: { to: Address; data: Hex; value?: bigint }[] }[] = [];
  let block = 9_000_000_000n;
  let approved = false;
  let batchSent = false;
  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      events.push(`read:${functionName}`);
      if (functionName === 'allowance') return opts.allowance ?? 0n;
      if (functionName === 'creationFee') return approved ? (opts.feeAfterApproval ?? FEE) : FEE;
      if (functionName === 'openingFdvUsd8') return approved ? (opts.fdvAfterApproval ?? FDV) : (opts.fdv ?? FDV);
      if (functionName === 'previewOpening') return [1n, approved ? (opts.tickAfterApproval ?? opts.tick ?? TICK) : (opts.tick ?? TICK), 23_000_000_000n];
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateCalls: async (args: { calls: { to: Address; data: Hex; value?: bigint }[] }) => {
      events.push('simulateCalls');
      simulated.push(args);
      if (opts.simulate === 'unsupported') throw new Error('the method eth_simulateV1 does not exist/is not available');
      if (batchSent && opts.simulateAfterSend) return { results: opts.simulateAfterSend };
      return { results: opts.simulate ?? args.calls.map(() => ({ status: 'success' })) };
    },
    getBlock: async () => {
      block += 10n;
      events.push(`block:${block}`);
      return { timestamp: block };
    },
    call: async () => {
      events.push('simulate');
      return { data: '0x' };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      events.push(`receipt:${hash}`);
      if (hash === '0xa1') approved = true;
      return { status: 'success' };
    },
  };
  const walletClient = {
    getCapabilities: async () => (opts.atomic ? { atomic: { status: 'supported' } } : {}),
    sendCalls: async (args: { calls: { to: Address; data: Hex; value?: bigint }[] }) => {
      events.push('sendCalls');
      batchSent = true;
      batches.push(args);
      return { id: 'batch' };
    },
    waitForCallsStatus: async () => ({ status: opts.batchStatus ?? 'success', receipts: [{ transactionHash: '0xb1' }] }),
    sendTransaction: async (tx: { to: Address; data: Hex; value?: bigint }) => {
      sent.push(tx);
      const hash = tx.to === STOCK ? '0xa1' : '0xf1';
      events.push(`send:${hash}`);
      return hash;
    },
  };
  return { ctx: { account: opts.account ?? ACCOUNT, chainId: opts.chainId ?? 8453, walletClient, publicClient } as never, events, sent, batches, simulated };
}

const reviewedQuote = quoteDevBuy({ predicted: PREDICTED, stock: STOCK, openingTick: TICK, stockIn: BUY_IN });
const plan = (buy: boolean): LaunchPlan => ({
  account: ACCOUNT,
  chainId: 8453,
  factory: FACTORY,
  stock: STOCK,
  name: 'Test',
  symbol: 'TEST',
  salt: SALT,
  predicted: PREDICTED,
  metadataEditable: false,
  reviewedFdv: FDV,
  creationFee: FEE,
  buy: buy ? { stockIn: BUY_IN, tokensOut: reviewedQuote.tokensOut, toleranceBps: 200 } : null,
});
const pin = async () => 'ipfs://bafypinned';

describe('executeLaunch', () => {
  it('without a buy: pins, simulates launchWithOptions and sends it with the creation fee', async () => {
    const f = fakeClients({});
    const states: LaunchState[] = [];
    const result = await executeLaunch(f.ctx, plan(false), pin, { onState: (s) => states.push(s) });
    expect(result).toEqual({ txHash: '0xf1', token: PREDICTED, mode: 'single' });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.value).toBe(FEE);
    const decoded = decodeLaunch(f.sent[0]!.data);
    expect(decoded.functionName).toBe('launchWithOptions');
    expect((decoded.args as readonly [{ contractURI: string }])[0].contractURI).toBe('ipfs://bafypinned');
    expect(f.events.indexOf('simulate')).toBeLessThan(f.events.indexOf('send:0xf1'));
    expect(states[0]).toBe('PINNING');
    expect(states.at(-1)).toBe('CONFIRMED');
  });

  it('atomic wallets get one batch: an exact approval, then the launch carrying the value', async () => {
    const f = fakeClients({ atomic: true });
    const result = await executeLaunch(f.ctx, plan(true), pin);
    expect(result.mode).toBe('batched');
    expect(f.sent).toHaveLength(0);
    const [approve, launch] = f.batches[0]!.calls;
    expect(approve!.to).toBe(STOCK);
    expect(approve!.value).toBeUndefined();
    const approval = decodeFunctionData({ abi: erc20Abi, data: approve!.data.slice(0, 138) as Hex });
    expect(approval.functionName).toBe('approve');
    expect(approval.args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a))).toEqual([FACTORY, BUY_IN]);
    expect(launch!.to).toBe(FACTORY);
    expect(launch!.value).toBe(FEE);
    const decoded = decodeLaunch(launch!.data);
    expect(decoded.functionName).toBe('launchAndBuy');
    // Deadline computed just before sending: from the last block read before the batch went out.
    const lastBlock = f.events.filter((e) => e.startsWith('block:')).at(-1)!;
    expect(f.events.indexOf(lastBlock)).toBeLessThan(f.events.indexOf('sendCalls'));
    expect((decoded.args as readonly [unknown, { deadline: bigint }])[1].deadline).toBe(BigInt(lastBlock.slice(6)) + 600n);
  });

  it('sequential wallets: calldata and deadline are built after the approval receipt, with the reviewed minimum', async () => {
    const better = [TICK - 300, TICK + 300].find((t) => quoteDevBuy({ predicted: PREDICTED, stock: STOCK, openingTick: t, stockIn: BUY_IN }).tokensOut > reviewedQuote.tokensOut)!;
    expect(better).toBeDefined();
    const f = fakeClients({ tickAfterApproval: better });
    const result = await executeLaunch(f.ctx, plan(true), pin);
    expect(result).toEqual({ txHash: '0xf1', token: PREDICTED, mode: 'sequential' });
    expect(f.sent.map((t) => t.to)).toEqual([STOCK, FACTORY]);
    const receipt = f.events.indexOf('receipt:0xa1');
    const blocks = f.events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith('block:'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]![1]).toBeGreaterThan(receipt);
    expect(f.events.indexOf('read:previewOpening')).toBeGreaterThan(receipt);
    expect(f.events.indexOf('simulate')).toBeGreaterThan(receipt);
    const decoded = decodeLaunch(f.sent[1]!.data);
    const [, options, buy] = decoded.args as readonly [unknown, { deadline: bigint }, { stockIn: bigint; minTokensOut: bigint }];
    expect(options.deadline).toBe(BigInt(blocks[0]![0].slice(6)) + 600n);
    // A better fresh quote does not raise the stakes either: the minimum stays the reviewed one.
    expect(buy).toEqual({ stockIn: BUY_IN, minTokensOut: devBuyMinOut(reviewedQuote.tokensOut, 200) });
    expect(f.sent[1]!.value).toBe(FEE);
  });

  it('sequential wallets: stops before the launch when the fresh quote is below the reviewed minimum', async () => {
    const worse = [TICK - 300, TICK + 300].find((t) => quoteDevBuy({ predicted: PREDICTED, stock: STOCK, openingTick: t, stockIn: BUY_IN }).tokensOut < devBuyMinOut(reviewedQuote.tokensOut, 200))!;
    expect(worse).toBeDefined();
    const f = fakeClients({ tickAfterApproval: worse });
    await expect(executeLaunch(f.ctx, plan(true), pin)).rejects.toEqual(new LaunchAbort('PriceMoved'));
    expect(f.sent.map((t) => t.to)).toEqual([STOCK]);
    expect(describeLaunchError(new LaunchAbort('PriceMoved'), { stock: 'NVDAc', ticker: 'NVDA' })).toBe('The price moved since you reviewed. Review the new quote.');
  });

  it('sequential wallets: stops when the fee or the FDV changed during the approval', async () => {
    const fee = fakeClients({ feeAfterApproval: FEE + 1n });
    await expect(executeLaunch(fee.ctx, plan(true), pin)).rejects.toEqual(new LaunchAbort('WrongCreationFee'));
    const fdv = fakeClients({ fdvAfterApproval: FDV - 1n });
    await expect(executeLaunch(fdv.ctx, plan(true), pin)).rejects.toEqual(new LaunchAbort('OpeningFdvChanged'));
    expect(fdv.sent.map((t) => t.to)).toEqual([STOCK]);
  });

  it('skips the approval when the allowance already covers the buy, and still re-quotes before sending', async () => {
    const f = fakeClients({ allowance: BUY_IN, atomic: true });
    const result = await executeLaunch(f.ctx, plan(true), pin);
    expect(result.mode).toBe('sequential');
    expect(f.batches).toHaveLength(0);
    expect(f.sent.map((t) => t.to)).toEqual([FACTORY]);
    expect(f.events.indexOf('read:previewOpening')).toBeLessThan(f.events.indexOf('simulate'));
  });

  it('falls back to plain launch on a factory without the launch options', async () => {
    const f = fakeClients({});
    await executeLaunch(f.ctx, { ...plan(false), legacy: true }, pin);
    expect(decodeLaunch(f.sent[0]!.data).functionName).toBe('launch');
    await expect(executeLaunch(f.ctx, { ...plan(true), legacy: true }, pin)).rejects.toThrow(/cannot buy at launch/u);
  });

  it('reads and sends nothing when pinning fails', async () => {
    const f = fakeClients({});
    await expect(executeLaunch(f.ctx, plan(true), async () => { throw new Error('Pinata returned no CID.'); })).rejects.toThrow('Pinata returned no CID.');
    expect(f.sent).toHaveLength(0);
    expect(f.events).toHaveLength(0);
  });
});

const names = { stock: 'NVDAc', ticker: 'NVDA' };
const reverted = (errorName: string) => new RawContractError({ data: encodeErrorResult({ abi: stockPairFactoryAbi, errorName } as never) });
const atTick = { predicted: PREDICTED, stock: STOCK, openingTick: TICK };
/** A feed move of three buckets in the direction that buys more tokens for the same stock. */
const better = [TICK - 300, TICK + 300].find((t) => quoteDevBuy({ ...atTick, openingTick: t, stockIn: BUY_IN }).tokensOut > reviewedQuote.tokensOut)!;
const worse = [TICK - 300, TICK + 300].find((t) => t !== better)!;

describe('executeLaunch: the reviewed wallet', () => {
  it('refuses another wallet or chain before pinning, reading or sending anything', async () => {
    let pins = 0;
    const counting = async () => {
      pins += 1;
      return 'ipfs://bafypinned';
    };
    const other = fakeClients({ account: '0xc0ffee0000000000000000000000000000000002' });
    await expect(executeLaunch(other.ctx, plan(true), counting)).rejects.toEqual(new LaunchAbort('AccountChanged'));
    const chain = fakeClients({ chainId: 1 });
    await expect(executeLaunch(chain.ctx, plan(false), counting)).rejects.toEqual(new LaunchAbort('AccountChanged'));
    expect(pins).toBe(0);
    expect([...other.events, ...chain.events]).toEqual([]);
    expect(describeLaunchError(new LaunchAbort('AccountChanged'), names)).toBe('Your wallet or network changed since you reviewed. Nothing was sent. Review again.');

    const sameInOtherCase = fakeClients({ account: ACCOUNT.toUpperCase().replace('0X', '0x') as Address });
    await expect(executeLaunch(sameInOtherCase.ctx, plan(false), counting)).resolves.toMatchObject({ token: PREDICTED });
  });
});

describe('executeLaunch: batched wallets', () => {
  it('re-reads the terms before the wallet opens and sends nothing when they moved', async () => {
    const fdv = fakeClients({ atomic: true, fdv: FDV - 1n });
    await expect(executeLaunch(fdv.ctx, plan(true), pin)).rejects.toEqual(new LaunchAbort('OpeningFdvChanged'));
    const price = fakeClients({ atomic: true, tick: worse });
    await expect(executeLaunch(price.ctx, plan(true), pin)).rejects.toEqual(new LaunchAbort('PriceMoved'));
    expect([...fdv.events, ...price.events]).not.toContain('sendCalls');
  });

  it('simulates the approval and the launch as one batch, exactly as sent, and surfaces its revert', async () => {
    const ok = fakeClients({ atomic: true });
    await executeLaunch(ok.ctx, plan(true), pin);
    expect(ok.events.indexOf('simulateCalls')).toBeLessThan(ok.events.indexOf('sendCalls'));
    expect(ok.simulated[0]!.calls).toEqual(ok.batches[0]!.calls);

    const failing = fakeClients({ atomic: true, simulate: [{ status: 'success' }, { status: 'failure', error: reverted('TooLittleReceived') }] });
    const err = await executeLaunch(failing.ctx, plan(true), pin).catch((e: unknown) => e);
    expect(describeLaunchError(err, names)).toBe("NVDA's price moved and your buy would get fewer tokens than your minimum. Nothing was launched or spent. Review the new quote.");
    expect(failing.events).not.toContain('sendCalls');
  });

  it('still sends after the re-quote on a node that cannot simulate a batch', async () => {
    const f = fakeClients({ atomic: true, simulate: 'unsupported' });
    await expect(executeLaunch(f.ctx, plan(true), pin)).resolves.toMatchObject({ mode: 'batched' });
  });

  it('names the reason when a sent batch failed, so Try again does not resend a doomed batch', async () => {
    const fee = fakeClients({ atomic: true, batchStatus: 'failure', simulateAfterSend: [{ status: 'success' }, { status: 'failure', error: reverted('WrongCreationFee') }] });
    const err = await executeLaunch(fee.ctx, plan(true), pin).catch((e: unknown) => e);
    expect(describeLaunchError(err, names)).toBe('The creation fee changed. Refresh and review.');
    expect(launchNeedsReview(err)).toBe(true);

    const unknown = fakeClients({ atomic: true, batchStatus: 'failure' });
    const plain = await executeLaunch(unknown.ctx, plan(true), pin).catch((e: unknown) => e);
    expect((plain as Error).message).toBe('The batched transaction did not succeed. Nothing was launched.');
    expect(launchNeedsReview(plain)).toBe(false);
  });
});

describe('executeLaunch: share tiers at send time', () => {
  const tierPlan = (shareBps: number, shareAck = false): LaunchPlan => {
    const stockIn = stockInForShare(shareBps, atTick);
    return { ...plan(true), buy: { stockIn, tokensOut: quoteDevBuy({ ...atTick, stockIn }).tokensOut, toleranceBps: 200, shareAck } };
  };
  // A stock price that rose since the review, on every path the buy can take.
  const paths = [
    { name: 'allowance already there', opts: { allowance: 10n ** 30n, tick: better } },
    { name: 'batched', opts: { atomic: true, tick: better } },
    { name: 'after a sequential approval', opts: { tickAfterApproval: better } },
  ];

  it('never sends a buy that now reaches half the supply', async () => {
    const reviewed = tierPlan(4_990, true);
    expect(devBuyTier(quoteDevBuy({ ...atTick, stockIn: reviewed.buy!.stockIn }).supplyBps)).toBe('confirm');
    expect(quoteDevBuy({ ...atTick, openingTick: better, stockIn: reviewed.buy!.stockIn }).supplyBps).toBeGreaterThanOrEqual(5_000n);
    for (const { name, opts } of paths) {
      const f = fakeClients(opts);
      await expect(executeLaunch(f.ctx, reviewed, pin), name).rejects.toEqual(new LaunchAbort('ShareLimit'));
      expect(f.sent.filter((t) => t.to === FACTORY), name).toEqual([]);
      expect(f.batches, name).toEqual([]);
    }
  });

  it('needs a fresh review when the buy crosses 15% without the tick, and sends when it was ticked', async () => {
    const unticked = tierPlan(1_490);
    expect(devBuyTier(quoteDevBuy({ ...atTick, stockIn: unticked.buy!.stockIn }).supplyBps)).toBe('notice');
    for (const { name, opts } of paths) {
      const f = fakeClients(opts);
      await expect(executeLaunch(f.ctx, unticked, pin), name).rejects.toEqual(new LaunchAbort('ShareUnconfirmed'));
      expect(f.sent.filter((t) => t.to === FACTORY), name).toEqual([]);
      const ticked = fakeClients(opts);
      await expect(executeLaunch(ticked.ctx, tierPlan(1_490, true), pin), name).resolves.toMatchObject({ token: PREDICTED });
    }
    expect(launchNeedsReview(new LaunchAbort('ShareUnconfirmed'))).toBe(true);
  });
});

describe('executeLaunch: the deadline it reports', () => {
  it('is the one signed into the call, on every path, and there is none for a plain launch', async () => {
    const deadlineOf = (data: Hex) => (decodeLaunch(data).args as readonly [unknown, { deadline: bigint }])[1].deadline;
    for (const [opts, buy] of [[{}, false], [{ allowance: BUY_IN }, true], [{}, true]] as const) {
      const seen: bigint[] = [];
      const f = fakeClients(opts);
      await executeLaunch(f.ctx, plan(buy), pin, { onDeadline: (d) => seen.push(d) });
      expect(seen).toEqual([deadlineOf(f.sent.at(-1)!.data)]);
    }
    const seen: bigint[] = [];
    const batched = fakeClients({ atomic: true });
    await executeLaunch(batched.ctx, plan(true), pin, { onDeadline: (d) => seen.push(d) });
    expect(seen).toEqual([deadlineOf(batched.batches[0]!.calls[1]!.data)]);

    const none: bigint[] = [];
    const legacy = fakeClients({});
    await executeLaunch(legacy.ctx, { ...plan(false), legacy: true }, pin, { onDeadline: (d) => none.push(d) });
    expect(none).toEqual([]);
  });
});

describe('one pin per review', () => {
  it('pins once and hands the same URI to every retry', async () => {
    let pins = 0;
    const once = pinOnce(async () => `ipfs://pin${(pins += 1)}`);
    const fee = fakeClients({ feeAfterApproval: FEE + 1n });
    await expect(executeLaunch(fee.ctx, plan(true), once)).rejects.toEqual(new LaunchAbort('WrongCreationFee'));
    const retry = fakeClients({ allowance: BUY_IN });
    await executeLaunch(retry.ctx, plan(true), once);
    expect(pins).toBe(1);
    expect((decodeLaunch(retry.sent[0]!.data).args as readonly [{ contractURI: string }])[0].contractURI).toBe('ipfs://pin1');
  });

  it('does not keep a pin that failed', async () => {
    let pins = 0;
    const once = pinOnce(async () => {
      pins += 1;
      if (pins === 1) throw new Error('Pinata returned no CID.');
      return 'ipfs://pinned';
    });
    await expect(once()).rejects.toThrow('Pinata returned no CID.');
    expect(await once()).toBe('ipfs://pinned');
    expect(await once()).toBe('ipfs://pinned');
    expect(pins).toBe(2);
  });
});

describe('what a failed launch offers next', () => {
  it('sends moved terms back to review, and leaves the rest to a retry', () => {
    for (const reason of ['PriceMoved', 'OpeningFdvChanged', 'WrongCreationFee', 'AccountChanged', 'ShareLimit', 'ShareUnconfirmed'] as const) {
      expect(launchNeedsReview(new LaunchAbort(reason)), reason).toBe(true);
    }
    for (const name of ['OpeningFdvChanged', 'WrongCreationFee', 'TooLittleReceived', 'StockNotEnabled', 'StaleFeed', 'InvalidFeed']) {
      expect(launchNeedsReview(reverted(name)), name).toBe(true);
    }
    expect(launchNeedsReview(reverted('Expired'))).toBe(false);
    expect(launchNeedsReview(new Error('User rejected the request.'))).toBe(false);
  });

  it('reads a paused stock out of a failed opening preview', () => {
    for (const name of ['StockNotEnabled', 'StaleFeed', 'InvalidFeed']) {
      expect(pausedReason(reverted(name), names), name).toBe('Launches against NVDAc are paused right now.');
    }
    expect(pausedReason(reverted('OpeningFdvChanged'), names)).toBeNull();
    expect(pausedReason(new Error('HTTP request failed'), names)).toBeNull();
  });
});
