import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readDeployments, type StockPairDeployment } from '@stockpair/core';

import { claimsByHook, deploymentOf, distinctHooks, hookOf } from '@/lib/deployments';
import { sortClaimableResults } from '@/lib/onchain.server';

const first: StockPairDeployment = {
  factory: '0x1000000000000000000000000000000000000001',
  hook: '0x2000000000000000000000000000000000000001',
  router: '0x3000000000000000000000000000000000000001',
  deployBlock: 50_932_763n,
};
const second: StockPairDeployment = {
  factory: '0x1000000000000000000000000000000000000002',
  hook: '0x2000000000000000000000000000000000000002',
  router: '0x3000000000000000000000000000000000000002',
  deployBlock: 51_500_000n,
};
const both = [first, second];

describe('which deployment a token belongs to', () => {
  it('matches the stored hook or factory, in any case', () => {
    expect(deploymentOf(both, { hook: second.hook.toUpperCase().replace('0X', '0x') })).toBe(second);
    expect(deploymentOf(both, { factory: first.factory })).toBe(first);
  });

  it('treats a row without a deployment as the oldest, which is the only one that existed then', () => {
    expect(deploymentOf(both, { hook: null, factory: null })).toBe(first);
    expect(hookOf(both, { hook: null })).toBe(first.hook);
    expect(hookOf(both, { hook: second.hook })).toBe(second.hook.toLowerCase());
  });

  it('refuses to guess for a hook this build does not know', () => {
    expect(deploymentOf(both, { hook: '0x9999999999999999999999999999999999999999' })).toBeNull();
    expect(deploymentOf([], { hook: null })).toBeNull();
    expect(hookOf([], { hook: null })).toBeNull();
  });
});

describe('claims across hooks', () => {
  it('sends one claim per hook with the stocks that hook owes', () => {
    const nvda = '0xb20000000000000000000078ee7ce2fE4908108C';
    const aapl = '0xb200000000000000000000C2e324d24d7eEcd1fb';
    expect(
      claimsByHook([
        { stock: nvda, hook: first.hook },
        { stock: aapl, hook: second.hook },
        { stock: nvda, hook: second.hook.toLowerCase() },
        { stock: nvda.toLowerCase(), hook: first.hook },
      ]),
    ).toEqual([
      { hook: first.hook, stocks: [nvda] },
      { hook: second.hook, stocks: [aapl, nvda] },
    ]);
  });

  it('reads each hook once even when two deployments share one', () => {
    expect(distinctHooks([first, { ...second, hook: first.hook }])).toEqual([first.hook]);
    expect(distinctHooks(both)).toEqual([first.hook, second.hook]);
  });
});

describe('claimable balances read across hooks', () => {
  const nvda = { address: '0xb20000000000000000000078ee7ce2fE4908108C', symbol: 'NVDAc' };
  const aapl = { address: '0xb200000000000000000000C2e324d24d7eEcd1fb', symbol: 'AAPLc' };
  const pairs = [first.hook, second.hook].flatMap((hook) => [nvda, aapl].map((stock) => ({ hook, stock })));
  const ok = (result: bigint) => ({ status: 'success' as const, result });
  const failed = { status: 'failure' as const, error: new Error('no code at this address') };

  it('keeps the first deployment claimable when a later hook cannot be read', () => {
    expect(sortClaimableResults(pairs, [ok(10n), ok(0n), failed, failed])).toEqual({
      balances: [{ stock: nvda.address, symbol: 'NVDAc', amountRaw: '10', hook: first.hook }],
      unreadHooks: [second.hook],
    });
  });

  it('never reports a hook with one failed read as empty, and knows nothing when no hook answered', () => {
    // One stock of the second hook failed: none of its balances is shown, and it is named as unread.
    expect(sortClaimableResults(pairs, [ok(10n), ok(0n), ok(5n), failed])).toEqual({
      balances: [{ stock: nvda.address, symbol: 'NVDAc', amountRaw: '10', hook: first.hook }],
      unreadHooks: [second.hook],
    });
    expect(sortClaimableResults(pairs, [failed, ok(1n), failed, ok(1n)])).toBeNull();
    expect(sortClaimableResults([], [])).toBeNull();
  });

  it('lists every non-zero balance when every hook answered', () => {
    expect(sortClaimableResults(pairs, [ok(1n), ok(0n), ok(2n), ok(3n)])).toEqual({
      balances: [
        { stock: nvda.address, symbol: 'NVDAc', amountRaw: '1', hook: first.hook },
        { stock: nvda.address, symbol: 'NVDAc', amountRaw: '2', hook: second.hook },
        { stock: aapl.address, symbol: 'AAPLc', amountRaw: '3', hook: second.hook },
      ],
      unreadHooks: [],
    });
  });

  it('reads with allowFailure, so one hook failing is that hook, not the whole read', () => {
    const source = readFileSync(fileURLToPath(new URL('../lib/onchain.server.ts', import.meta.url)), 'utf8');
    const call = source.slice(source.indexOf('export async function readClaimable'));
    expect(call).toContain('allowFailure: true');
    expect(call).toContain('sortClaimableResults(');
  });
});

describe('server configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The single keys stay on the first deployment for the code that still reads them, so a list
  // under either prefix has to win over them, or the server never sees the newer deployment.
  it('prefers a public list over the server-side single keys', async () => {
    vi.stubEnv('STOCKPAIR_DEPLOYMENTS', '');
    vi.stubEnv('STOCKPAIR_FACTORY', first.factory);
    vi.stubEnv('STOCKPAIR_HOOK', first.hook);
    vi.stubEnv('STOCKPAIR_ROUTER', first.router);
    vi.stubEnv(
      'NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS',
      JSON.stringify(both.map((d) => ({ ...d, deployBlock: Number(d.deployBlock) }))),
    );
    const { serverDeployments, serverDeployment } = await import('@/lib/chain.server');
    expect(serverDeployments().map((d) => d.factory)).toEqual([first.factory, second.factory]);
    expect(serverDeployment()?.factory).toBe(second.factory);
  });

  it('prefers its own list over a public one, and the single keys only when there is no list', async () => {
    vi.stubEnv('STOCKPAIR_DEPLOYMENTS', JSON.stringify([{ ...first, deployBlock: Number(first.deployBlock) }]));
    vi.stubEnv(
      'NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS',
      JSON.stringify(both.map((d) => ({ ...d, deployBlock: Number(d.deployBlock) }))),
    );
    const own = await import('@/lib/chain.server');
    expect(own.serverDeployments().map((d) => d.factory)).toEqual([first.factory]);

    vi.unstubAllEnvs();
    vi.resetModules();
    vi.stubEnv('STOCKPAIR_DEPLOYMENTS', '');
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS', '');
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_FACTORY', first.factory);
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_HOOK', first.hook);
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_ROUTER', first.router);
    const single = await import('@/lib/chain.server');
    expect(single.serverDeployments().map((d) => d.factory)).toEqual([first.factory]);
  });
});

describe('browser configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exposes every deployment and the newest from the public list', async () => {
    vi.stubEnv(
      'NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS',
      JSON.stringify(both.map((d) => ({ ...d, deployBlock: Number(d.deployBlock) }))),
    );
    const { publicEnv, requireDeployment } = await import('@/lib/env');
    expect(publicEnv.deployments.map((d) => d.factory)).toEqual([first.factory, second.factory]);
    expect(publicEnv.newest?.factory).toBe(second.factory);
    expect(publicEnv.deployment?.factory).toBe(second.factory);
    expect(requireDeployment().hook).toBe(second.hook);
  });

  it('still reads the single keys when there is no list', async () => {
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS', '');
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_FACTORY', first.factory);
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_HOOK', first.hook);
    vi.stubEnv('NEXT_PUBLIC_STOCKPAIR_ROUTER', first.router);
    const { publicEnv } = await import('@/lib/env');
    expect(publicEnv.deployments).toEqual(readDeployments({ NEXT_PUBLIC_STOCKPAIR_FACTORY: first.factory, NEXT_PUBLIC_STOCKPAIR_HOOK: first.hook, NEXT_PUBLIC_STOCKPAIR_ROUTER: first.router }, 'NEXT_PUBLIC_STOCKPAIR'));
    expect(publicEnv.newest?.factory).toBe(first.factory);
  });
});
