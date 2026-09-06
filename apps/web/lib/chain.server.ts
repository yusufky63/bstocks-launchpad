import 'server-only';

import { createPublicClient, fallback, http } from 'viem';
import { base } from 'viem/chains';

import { readDeployment, type StockPairDeployment } from '@stockpair/core';

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

export function serverDeployment(): StockPairDeployment | null {
  return readDeployment(process.env, 'STOCKPAIR') ?? readDeployment(process.env, 'NEXT_PUBLIC_STOCKPAIR');
}

export function getPublicClient(): BaseClient {
  if (!registry.__stockpairClient) registry.__stockpairClient = makeClient();
  return registry.__stockpairClient;
}
