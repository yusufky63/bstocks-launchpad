import 'server-only';

import { createPublicClient, fallback, http } from 'viem';
import { base } from 'viem/chains';

import { readDeployments, type StockPairDeployment } from '@stockpair/core';

function makeClient() {
  const urls = [process.env.BASE_RPC_URL, process.env.BASE_RPC_URL_FALLBACK, 'https://mainnet.base.org']
    .filter((u): u is string => Boolean(u && u.trim()));
  return createPublicClient({
    chain: base,
    transport: fallback(urls.map((url) => http(url, { batch: true, retryCount: 1, timeout: 8_000 })), { rank: false }),
  });
}

export type BaseClient = ReturnType<typeof makeClient>;

const registry = globalThis as typeof globalThis & { __stockpairClient?: BaseClient };

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

export function getPublicClient(): BaseClient {
  if (!registry.__stockpairClient) registry.__stockpairClient = makeClient();
  return registry.__stockpairClient;
}
