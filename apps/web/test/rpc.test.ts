import { createPublicClient, custom, encodeFunctionResult, erc20Abi, multicall3Abi, decodeFunctionData, type Hex } from 'viem';
import { base } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import { FREE_BASE_RPC_URLS, rpcOrder } from '@/lib/chain.server';

describe('which RPC a server read goes to', () => {
  const env = { BASE_RPC_URL: 'https://paid.example/rpc', BASE_RPC_URL_FALLBACK: 'https://paid-2.example/rpc' };

  it('tries the paid RPC first for reads a trade depends on', () => {
    expect(rpcOrder('paid-first', env)).toEqual(['https://paid.example/rpc', 'https://paid-2.example/rpc', 'https://mainnet.base.org']);
  });

  it('tries the free endpoints first for reads that are only shown, and the paid one last', () => {
    const order = rpcOrder('free-first', env);
    expect(order.slice(0, FREE_BASE_RPC_URLS.length)).toEqual([...FREE_BASE_RPC_URLS]);
    expect(order.at(-1)).toBe('https://paid-2.example/rpc');
    // Without a paid RPC configured the free ones are all there is.
    expect(rpcOrder('free-first', {})).toEqual([...FREE_BASE_RPC_URLS]);
  });

  it('never lists a keyed endpoint among the free ones', () => {
    for (const url of FREE_BASE_RPC_URLS) expect(url).not.toMatch(/alchemy|infura|quiknode|\/v2\/|api[-_]?key/iu);
  });
});

describe('folding reads into one call', () => {
  it('sends reads issued together as a single Multicall3 eth_call, as the server client is set up to', async () => {
    const requests: string[] = [];
    const client = createPublicClient({
      chain: base,
      batch: { multicall: { batchSize: 16_384, wait: 16 } },
      transport: custom({
        async request({ method, params }: { method: string; params: unknown[] }) {
          requests.push(method);
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
          const { data } = (params as [{ data: Hex }])[0];
          const { args } = decodeFunctionData({ abi: multicall3Abi, data });
          const calls = args[0] as readonly unknown[];
          // Every balance read answers 7.
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            result: calls.map(() => ({ success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 7n }) })),
          });
        },
      }),
    });
    const holder = '0x1111111111111111111111111111111111111111';
    const tokens = Array.from({ length: 26 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as const);
    const balances = await Promise.all(tokens.map((address) => client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })));
    expect(balances).toEqual(tokens.map(() => 7n));
    expect(requests).toEqual(['eth_call']);
  });
});
