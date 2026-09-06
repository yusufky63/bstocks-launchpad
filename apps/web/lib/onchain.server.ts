import 'server-only';

import { parseAbi, type Address } from 'viem';

import { BASE_STOCKS, stockPairFactoryAbi, stockPairHookAbi } from '@stockpair/core';

import { getPublicClient, serverDeployment } from './chain.server';

const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function contractURI() view returns (string)',
]);

export type OnchainLaunch = {
  token: Address;
  stock: Address;
  creator: Address;
  name: string;
  symbol: string;
  contractURI: string;
  launchedAt: string;
  openingSqrtPriceX96: string;
  stockUsd8: string;
};

/** Reads a launch straight from the factory, for tokens the indexer has not stored yet. */
export async function readLaunchOnchain(token: Address): Promise<OnchainLaunch | null> {
  const deployment = serverDeployment();
  if (!deployment) return null;
  const client = getPublicClient();
  try {
    const launch = await client.readContract({
      address: deployment.factory,
      abi: stockPairFactoryAbi,
      functionName: 'launchOf',
      args: [token],
    });
    if (launch.launchedAt === 0n) return null;
    const [name, symbol, contractURI] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'contractURI' }).catch(() => ''),
    ]);
    return {
      token,
      stock: launch.stock,
      creator: launch.creator,
      name,
      symbol,
      contractURI,
      launchedAt: new Date(Number(launch.launchedAt) * 1000).toISOString(),
      openingSqrtPriceX96: launch.openingSqrtPriceX96.toString(),
      stockUsd8: launch.stockUsd8.toString(),
    };
  } catch {
    return null;
  }
}

/** Claimable fee balances for an account across every stock, straight from the hook. */
export async function readClaimable(account: Address): Promise<{ stock: Address; symbol: string; amountRaw: string }[]> {
  const deployment = serverDeployment();
  if (!deployment) return [];
  const client = getPublicClient();
  const results = await client.multicall({
    contracts: BASE_STOCKS.map((stock) => ({
      address: deployment.hook,
      abi: stockPairHookAbi,
      functionName: 'claimable',
      args: [stock.address as Address, account],
    })),
    allowFailure: true,
  });
  return results.flatMap((result, index) => {
    const stock = BASE_STOCKS[index]!;
    if (result.status !== 'success' || result.result === 0n) return [];
    return [{ stock: stock.address as Address, symbol: stock.symbol, amountRaw: (result.result as bigint).toString() }];
  });
}
