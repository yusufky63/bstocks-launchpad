import { decodeFunctionData, encodeAbiParameters, erc20Abi, pad, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BASE_STOCKS, ERC20_TRANSFER_TOPIC, type RawLog } from '@stockpair/core';
import { applyBalanceDelta, createEmbeddedDb, insertLaunch, insertSwap, insertTransfer, migrate, upsertStockQuote, type Db } from '@stockpair/core/db';

import { GET as getActivity } from '@/app/api/activity/route';
import { GET as getStats } from '@/app/api/stats/route';
import { GET as getBurns } from '@/app/api/tokens/[address]/burns/route';
import { GET as getToken } from '@/app/api/tokens/[address]/route';
import { getBuilderDataSuffix } from '@/lib/attribution';
import { BURN_ADDRESS, burnCalldata, burnsFromReceipt, describeBurnError, executeBurn } from '@/lib/burn';
import { invalidate } from '@/lib/cache.server';
import { setDbForTests } from '@/lib/db.server';
import { formatSupplyPct } from '@/lib/format';
import { addPendingBurns, pendingBurns, withPendingBurnMarket, withPendingBurns, withPendingBurnSummary, type PendingBurn } from '@/lib/pending-burns';
import { resetRateLimits } from '@/lib/rate-limit.server';
import type { BurnSummary, BurnView } from '@/lib/types';
import { parse } from './helpers';

const TOKEN = '0xb2000000000000000000000000000000000000c7' as Address;
const OTHER = '0xb2000000000000000000000000000000000000c8' as Address;
const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const HOLDER = '0x2222222222222222222222222222222222222222' as Address;
const DEAD = '0x000000000000000000000000000000000000dead';
const WHOLE = 10n ** 18n;
const TX = `0x${'ab'.repeat(32)}` as Hex;

const strip = (data: Hex): Hex => {
  const suffix = getBuilderDataSuffix();
  return suffix && data.endsWith(suffix.slice(2)) ? (data.slice(0, data.length - (suffix.length - 2)) as Hex) : data;
};

function transferLog(token: Address, from: Address, to: string, value: bigint, logIndex: number): RawLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, pad(from), pad(to as Hex)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: 900n,
    transactionHash: TX,
    logIndex,
  };
}

describe('sending a burn', () => {
  it('is a transfer of the amount to 0x…dEaD on the token', () => {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: burnCalldata(5n * WHOLE) });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([BURN_ADDRESS, 5n * WHOLE]);
    expect(BURN_ADDRESS.toLowerCase()).toBe(DEAD);
  });

  it('simulates, sends from the holder with attribution, and waits for a successful receipt', async () => {
    const events: string[] = [];
    let sent: { to: Address; data: Hex } | null = null;
    const ctx = {
      account: HOLDER,
      walletClient: {
        sendTransaction: async (tx: { to: Address; data: Hex }) => {
          events.push('send');
          sent = tx;
          return TX;
        },
      },
      publicClient: {
        call: async () => {
          events.push('simulate');
          return { data: '0x' };
        },
        waitForTransactionReceipt: async () => {
          events.push('receipt');
          return { status: 'success', blockNumber: 900n, logs: [] };
        },
      },
    };
    const states: string[] = [];
    const result = await executeBurn(ctx as never, { token: TOKEN, amount: 7n * WHOLE }, { onState: (s) => states.push(s) });
    expect(events).toEqual(['simulate', 'send', 'receipt']);
    expect(states).toEqual(['AWAITING_WALLET', 'SUBMITTED', 'CONFIRMING']);
    expect(result.txHash).toBe(TX);
    expect(sent!.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: erc20Abi, data: strip(sent!.data) }).args).toEqual([BURN_ADDRESS, 7n * WHOLE]);

    const reverted = { ...ctx, publicClient: { ...ctx.publicClient, waitForTransactionReceipt: async () => ({ status: 'reverted' }) } };
    await expect(executeBurn(reverted as never, { token: TOKEN, amount: 1n })).rejects.toThrow('Nothing was burned');
    await expect(executeBurn(ctx as never, { token: TOKEN, amount: 0n })).rejects.toThrow('Enter an amount');
  });

  it('says what went wrong in words a holder can act on', () => {
    expect(describeBurnError(new Error('User rejected the request.'))).toBe('You declined the request in your wallet. Nothing was burned.');
    expect(describeBurnError(new Error('execution reverted: ERC20: transfer amount exceeds balance'))).toBe('This wallet does not hold that many tokens.');
    expect(describeBurnError(new Error('insufficient funds for gas * price + value'))).toBe('This wallet does not have enough ETH on Base for the gas.');
  });
});

describe('showing a share of the supply', () => {
  it('gives small burns the digits they need and keeps large ones short', () => {
    expect(formatSupplyPct(1.35)).toBe('1.35%');
    expect(formatSupplyPct(0.25)).toBe('0.25%');
    expect(formatSupplyPct(0.0035)).toBe('0.004%');
    expect(formatSupplyPct(0.0000005)).toBe('0.00000%');
    expect(formatSupplyPct(0)).toBe('0.00%');
    expect(formatSupplyPct(null)).toBe('—');
  });
});

describe('a burn read from its receipt', () => {
  const market = { token: TOKEN, name: 'Burnable', symbol: 'BRN', imageUrl: null, creator: CREATOR, priceUsd: 0.002 };
  const at = new Date('2026-10-04T12:00:00Z');

  it('takes only this token\'s transfers to the burn address', () => {
    const receipt = {
      blockNumber: 900n,
      logs: [
        transferLog(TOKEN, HOLDER, CREATOR, 1n * WHOLE, 0), // a plain transfer is not a burn
        transferLog(OTHER, HOLDER, DEAD, 9n * WHOLE, 1), // another token's burn is not this one's
        transferLog(TOKEN, HOLDER, DEAD, 10_000_000n * WHOLE, 2),
      ],
    };
    expect(burnsFromReceipt(receipt, market, at)).toEqual([
      {
        txHash: TX,
        logIndex: 2,
        token: TOKEN,
        name: 'Burnable',
        symbol: 'BRN',
        imageUrl: null,
        burner: HOLDER,
        isCreator: false,
        amount: 10_000_000,
        amountRaw: (10_000_000n * WHOLE).toString(),
        supplyPercent: 1,
        valueUsd: 20_000,
        blockNumber: '900',
        blockTime: at.toISOString(),
      },
    ]);
    expect(burnsFromReceipt({ blockNumber: 1n, logs: [transferLog(TOKEN, CREATOR, DEAD, WHOLE, 0)] }, { ...market, priceUsd: null }, at)[0]).toMatchObject({ isCreator: true, valueUsd: null });
  });
});

describe('pending burns', () => {
  const burn = (over: Partial<PendingBurn> = {}): PendingBurn => ({
    txHash: TX,
    logIndex: 2,
    token: TOKEN.toLowerCase(),
    name: 'Burnable',
    symbol: 'BRN',
    imageUrl: null,
    burner: HOLDER,
    isCreator: false,
    amount: 1_000_000,
    amountRaw: (1_000_000n * WHOLE).toString(),
    supplyPercent: 0.1,
    valueUsd: 2_000,
    blockNumber: '900',
    blockTime: '2026-10-04T12:00:00.000Z',
    recordedAt: 0,
    indexedAt: null,
    ...over,
  });

  it('puts the burns the indexed list lacks on top, marked', () => {
    const indexed: BurnView[] = [{ ...burn({ txHash: `0x${'01'.repeat(32)}`, blockNumber: '800' }), pending: undefined }];
    expect(withPendingBurns(indexed, [burn()]).map((b) => [b.blockNumber, b.pending ?? false])).toEqual([
      ['900', true],
      ['800', false],
    ]);
    expect(withPendingBurns([burn()], [burn()])).toHaveLength(1);
  });

  it('adds them to totals that end before them, and not to totals that include them', () => {
    const summary: BurnSummary = { burned: 500, burnedRaw: (500n * WHOLE).toString(), supplyPercent: 0.00005, burns: 1, burners: 1, lastBurnAt: '2026-10-04T11:00:00.000Z', lastBurnBlock: '800', top: [] };
    expect(withPendingBurnSummary(summary, [burn()])).toMatchObject({ burned: 1_000_500, burnedRaw: (1_000_500n * WHOLE).toString(), burns: 2, burners: 1, lastBurnBlock: '900' });
    expect(withPendingBurnSummary({ ...summary, lastBurnBlock: '900' }, [burn()])).toEqual({ ...summary, lastBurnBlock: '900' });

    const market = { burned: 0, burnedPercent: 0, burns: 0, lastBurnBlock: null };
    expect(withPendingBurnMarket(market, [burn()])).toEqual({ burned: 1_000_000, burnedPercent: 0.1, burns: 1, lastBurnBlock: '900' });
    const caughtUp = { burned: 1_000_000, burnedPercent: 0.1, burns: 1, lastBurnBlock: '900' };
    expect(withPendingBurnMarket(caughtUp, [burn()])).toBe(caughtUp);
  });

  it('keeps one row per receipt log in the store', () => {
    addPendingBurns(OTHER, [burn({ token: OTHER })], 1_000);
    addPendingBurns(OTHER, [burn({ token: OTHER })], 1_100);
    expect(pendingBurns(OTHER)).toHaveLength(1);
  });
});

describe('burns through the API', () => {
  let db: Db;
  const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();

  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    setDbForTests(db);
    await upsertStockQuote(db, { stock: NVDAc, priceUsd8: 200n * 10n ** 8n, feedUpdatedAt: new Date(), observedAt: new Date(), observedBlock: 1n });
    const launchedAt = new Date(Date.now() - 60 * 60_000);
    await insertLaunch(db, {
      token: TOKEN,
      stock: NVDAc,
      creator: CREATOR.toLowerCase(),
      poolId: `0x${'c7'.repeat(32)}`,
      tokenIsCurrency0: true,
      name: 'Burnable',
      symbol: 'BRN',
      contractUri: 'ipfs://bafyburnable',
      openingSqrtPriceX96: 1n,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 1n,
      stockUsd8: 200n * 10n ** 8n,
      blockNumber: 100n,
      blockHash: '0xb',
      txHash: '0xlaunch',
      logIndex: 3,
      launchedAt,
    });
    await insertTransfer(db, { txHash: '0xlaunch', logIndex: 2, token: TOKEN, from: '0xfac7', to: DEAD, amountRaw: 5n, blockNumber: 100n, blockTime: launchedAt });
    await applyBalanceDelta(db, TOKEN, DEAD, 5n, 100n);
    await insertSwap(db, {
      txHash: '0xswap',
      logIndex: 1,
      token: TOKEN,
      poolId: `0x${'c7'.repeat(32)}`,
      side: 'buy',
      sender: '0x00000000000000000000000000000000000000e0',
      trader: HOLDER.toLowerCase(),
      amountTokenRaw: 20_000_000n * WHOLE,
      amountStockRaw: 100_000_000n,
      priceTokenInStock: '0.000010000000000000000000000000',
      sqrtPriceX96: 1n,
      liquidity: 1n,
      tick: 0,
      feeStockRaw: 0n,
      blockNumber: 110n,
      blockHash: '0xb',
      blockTime: new Date(Date.now() - 50 * 60_000),
    });
    for (const [i, [from, whole]] of ([[HOLDER, 10_000_000n], [CREATOR, 2_500_000n]] as const).entries()) {
      await insertTransfer(db, { txHash: `0xburn${i}`, logIndex: 0, token: TOKEN, from: from.toLowerCase(), to: DEAD, amountRaw: whole * WHOLE, blockNumber: 120n + BigInt(i), blockTime: new Date(Date.now() - (40 - i) * 60_000) });
      await applyBalanceDelta(db, TOKEN, DEAD, whole * WHOLE, 120n + BigInt(i));
    }
  });

  beforeEach(() => {
    invalidate();
    resetRateLimits();
  });

  afterAll(async () => {
    setDbForTests(null);
    await db.close();
  });

  const ctx = (address: string) => ({ params: Promise.resolve({ address }) });

  it('lists a token\'s burns with totals and the top burners, valued when burned', async () => {
    const { status, body } = await parse(await getBurns(new Request('http://x/api/tokens/x/burns?limit=10'), ctx(TOKEN)));
    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ burned: 12_500_000, supplyPercent: 1.25, burns: 2, burners: 2, lastBurnBlock: '121' });
    expect(body.summary.top.map((t: { burner: string }) => t.burner)).toEqual([HOLDER.toLowerCase(), CREATOR.toLowerCase()]);
    expect(body.burns.map((b: BurnView) => [b.burner, b.amount, b.isCreator])).toEqual([
      [CREATOR.toLowerCase(), 2_500_000, true],
      [HOLDER.toLowerCase(), 10_000_000, false],
    ]);
    // 10,000,000 tokens at 0.00001 NVDAc each, NVDAc at $200.
    expect(body.burns[1].valueUsd).toBeCloseTo(20_000, 6);

    const older = await parse(await getBurns(new Request('http://x/api/tokens/x/burns?limit=10&before=121&beforeLog=0'), ctx(TOKEN)));
    expect(older.body.summary).toBeNull();
    expect(older.body.burns).toHaveLength(1);
    expect((await getBurns(new Request('http://x/api/tokens/x/burns'), ctx(OTHER))).status).toBe(404);
    expect((await getBurns(new Request('http://x/api/tokens/x/burns?limit=0'), ctx(TOKEN))).status).toBe(400);
  });

  it('carries the burned share on the token, in the activity feed and in the platform totals', async () => {
    const token = await parse(await getToken(new Request('http://x'), ctx(TOKEN)));
    expect(token.body.market).toMatchObject({ burned: 12_500_000, burnedPercent: 1.25, burns: 2 });
    // FDV stays on the full supply.
    expect(token.body.market.fdvUsd).toBeCloseTo(0.00001 * 200 * 1e9, 3);

    const feed = await parse(await getActivity(new Request(`http://x/api/activity?token=${TOKEN}`)));
    expect(feed.body.items.map((i: { kind: string }) => i.kind)).toEqual(['burn', 'burn', 'swap', 'launch']);
    expect(feed.body.items[0]).toMatchObject({ kind: 'burn', amountToken: 2_500_000, side: null, isCreator: true });

    const stats = await parse(await getStats());
    expect(stats.body.burns).toMatchObject({ count: 2, burners: 2, tokens: 1 });
    expect(stats.body.burns.valueUsd).toBeCloseTo((10_000_000 + 2_500_000) * 0.00001 * 200, 6);
  });
});
