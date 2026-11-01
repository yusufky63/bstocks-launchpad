import 'server-only';

import { createPublicClient, fallback, http } from 'viem';
import { base } from 'viem/chains';

import { readDeployments, type StockPairDeployment } from '@stockpair/core';

/**
 * Base endpoints that need no key. They answer reads at or near the head (publicnode serves
 * eth_getLogs over 2,000 recent blocks; dRPC's free plan only short ranges) and refuse archive
 * reads, and Base's own is rate limited and not meant for production. So they carry only reads
 * whose refusal costs nothing: the next endpoint answers, the paid one last.
 */
export const FREE_BASE_RPC_URLS = ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'] as const;

function paidUrls(env: Readonly<Record<string, string | undefined>>): string[] {
  return [env.BASE_RPC_URL, env.BASE_RPC_URL_FALLBACK].filter((u): u is string => Boolean(u && u.trim()));
}

/** The order a client tries endpoints in: the paid RPC first for what matters, the free ones first for the rest. */
export function rpcOrder(kind: 'paid-first' | 'free-first', env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return kind === 'paid-first' ? [...paidUrls(env), 'https://mainnet.base.org'] : [...FREE_BASE_RPC_URLS, ...paidUrls(env)];
}

function makeClient(urls: readonly string[]) {
  return createPublicClient({
    chain: base,
    // Contract reads issued together leave as one Multicall3 eth_call, which the RPC bills as one
    // call: a quote's pool reads, a token's pool state and fee, a wallet's claimables per hook.
    // Calls that carry an account (simulations of a transaction) are never folded in.
    batch: { multicall: { batchSize: 16_384, wait: 16 } },
    transport: fallback(urls.map((url) => http(url, { batch: true, retryCount: 1, timeout: 8_000 })), { rank: false }),
  });
}

export type BaseClient = ReturnType<typeof makeClient>;

const registry = globalThis as typeof globalThis & { __stockpairClient?: BaseClient; __stockpairLightClient?: BaseClient };

/**
 * Every deployment, oldest first. A list under either prefix wins over the single keys: the single
 * keys stay pointed at the first deployment for the code that still reads them, so falling back to
 * them while a public list names the newer deployment would hide that deployment from every
 * server-side read (claims, launches not yet indexed).
 */
export function serverDeployments(): readonly StockPairDeployment[] {
  const env = process.env;
  const own = readDeployments(env, 'STOCKPAIR');
  if (env.STOCKPAIR_DEPLOYMENTS?.trim() && own.length > 0) return own;
  const shared = readDeployments(env, 'NEXT_PUBLIC_STOCKPAIR');
  if (env.NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS?.trim() && shared.length > 0) return shared;
  return own.length > 0 ? own : shared;
}

/** The newest deployment: the one new launches go to. */
export function serverDeployment(): StockPairDeployment | null {
  return serverDeployments().at(-1) ?? null;
}

/** The paid RPC first: quotes, transaction builds and launch reads, where a refusal or a stale block costs a trade. */
export function getPublicClient(): BaseClient {
  if (!registry.__stockpairClient) registry.__stockpairClient = makeClient(rpcOrder('paid-first'));
  return registry.__stockpairClient;
}

/**
 * The free endpoints first, the paid RPC last: reads that are only shown and are cached anyway, such
 * as names, a token's pool reserves and fee, claimable balances on a page and the health check.
 */
export function getLightClient(): BaseClient {
  if (!registry.__stockpairLightClient) registry.__stockpairLightClient = makeClient(rpcOrder('free-first'));
  return registry.__stockpairLightClient;
}
