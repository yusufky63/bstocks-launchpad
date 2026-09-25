import 'server-only';

import { parseAbi, type Address } from 'viem';

import { BASE_STOCKS, stockPairFactoryAbi, stockPairHookAbi } from '@stockpair/core';

import { getPublicClient, serverDeployments } from './chain.server';
import { distinctHooks } from './deployments';

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
  /** The factory that answered for this token, and its hook. */
  factory: Address;
  hook: Address;
};

/**
 * Reads a launch straight from the factory, for tokens the indexer has not stored yet. New tokens
 * come from the newest factory, so that is asked first; older ones only if it does not know the token.
 */
export async function readLaunchOnchain(token: Address): Promise<OnchainLaunch | null> {
  const deployments = [...serverDeployments()].reverse();
  if (deployments.length === 0) return null;
  const client = getPublicClient();
  try {
    for (const deployment of deployments) {
      const launch = await client.readContract({
        address: deployment.factory,
        abi: stockPairFactoryAbi,
        functionName: 'launchOf',
        args: [token],
      });
      if (launch.launchedAt === 0n) continue;
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
        factory: deployment.factory,
        hook: deployment.hook,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** The contract URI a token reports right now, straight from the token. */
export async function readTokenContractUri(token: Address): Promise<string> {
  return getPublicClient().readContract({ address: token, abi: erc20Abi, functionName: 'contractURI' });
}

export type ClaimableBalance = { stock: Address; symbol: string; amountRaw: string; hook: Address };

/** Balances from the hooks that answered in full, and the hooks that did not. */
export type ClaimableRead = { balances: ClaimableBalance[]; unreadHooks: Address[] };

type ClaimableResult = { status: 'success'; result: unknown } | { status: 'failure'; error?: unknown };

/**
 * Sorts one multicall's results by hook. A dropped entry and a zero balance are not the same thing:
 * silently discarding failures once turned an RPC blip into "Claimable now $0.00" with no Claim
 * button. So a hook with any failed read is reported as unread, never as empty. It is judged per hook
 * so that one broken or unreachable entry cannot hide the balances, and the Claim button, of the
 * hooks that did answer, such as the first deployment's. Null when no hook answered at all.
 */
export function sortClaimableResults(
  pairs: readonly { hook: Address; stock: { address: string; symbol: string } }[],
  results: readonly ClaimableResult[],
): ClaimableRead | null {
  const failed = new Set(pairs.filter((_, i) => results[i]?.status !== 'success').map((p) => p.hook.toLowerCase()));
  const hooks = [...new Map(pairs.map((p) => [p.hook.toLowerCase(), p.hook])).values()];
  if (hooks.length === 0 || hooks.every((h) => failed.has(h.toLowerCase()))) return null;
  const balances = pairs.flatMap(({ hook, stock }, index) => {
    const result = results[index];
    if (failed.has(hook.toLowerCase()) || result?.status !== 'success' || result.result === 0n) return [];
    return [{ stock: stock.address as Address, symbol: stock.symbol, amountRaw: (result.result as bigint).toString(), hook }];
  });
  return { balances, unreadHooks: hooks.filter((h) => failed.has(h.toLowerCase())) };
}

/**
 * Claimable fee balances for an account across every stock and every hook, straight from the chain.
 * Each hook books its own claims, so a creator with tokens on two deployments has two balances per
 * stock, withdrawn with one claim on each hook.
 */
export async function readClaimable(account: Address): Promise<ClaimableRead | null> {
  const hooks = distinctHooks(serverDeployments());
  if (hooks.length === 0) return null;
  const client = getPublicClient();
  const pairs = hooks.flatMap((hook) => BASE_STOCKS.map((stock) => ({ hook, stock })));
  const results = await client.multicall({
    contracts: pairs.map(({ hook, stock }) => ({
      address: hook,
      abi: stockPairHookAbi,
      functionName: 'claimable',
      args: [stock.address as Address, account],
    })),
    // Each call stands alone, so one hook's failure is visible as that hook's, not the whole read's.
    allowFailure: true,
  });
  return sortClaimableResults(pairs, results as readonly ClaimableResult[]);
}
