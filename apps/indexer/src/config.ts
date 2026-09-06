import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { readDeployment, type StockPairDeployment } from '@stockpair/core';
import { z } from 'zod';

export type IndexerConfig = Readonly<{
  databaseUrl: string;
  rpcUrls: readonly string[];
  deployment: StockPairDeployment;
  confirmations: number;
  pollMs: number;
  maxRange: number;
  quoteIntervalMs: number;
  ipfsGateway: string;
  healthPort: number;
}>;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BASE_RPC_URL: z.string().url(),
  BASE_RPC_URL_FALLBACK: z.string().url().optional(),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(3),
  INDEXER_POLL_MS: z.coerce.number().int().min(1_000).max(60_000).default(2_000),
  INDEXER_MAX_RANGE: z.coerce.number().int().min(10).max(10_000).default(2_000),
  INDEXER_QUOTE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  IPFS_GATEWAY: z.string().url().default('https://gateway.pinata.cloud'),
  INDEXER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8788),
});

export function loadEnvFiles(cwd = process.cwd()): void {
  for (const candidate of ['.env', '.env.local']) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) {
      try {
        process.loadEnvFile(path);
      } catch {
        // ignore parse issues; validation below reports what is missing
      }
    }
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): IndexerConfig {
  const parsed = schema.parse(env);
  const deployment = readDeployment(env, 'STOCKPAIR');
  if (!deployment) {
    throw new Error(
      'STOCKPAIR_FACTORY, STOCKPAIR_HOOK, STOCKPAIR_ROUTER and STOCKPAIR_DEPLOY_BLOCK are required.',
    );
  }
  return Object.freeze({
    databaseUrl: parsed.DATABASE_URL,
    rpcUrls: [parsed.BASE_RPC_URL, ...(parsed.BASE_RPC_URL_FALLBACK ? [parsed.BASE_RPC_URL_FALLBACK] : [])],
    deployment,
    confirmations: parsed.INDEXER_CONFIRMATIONS,
    pollMs: parsed.INDEXER_POLL_MS,
    maxRange: parsed.INDEXER_MAX_RANGE,
    quoteIntervalMs: parsed.INDEXER_QUOTE_INTERVAL_MS,
    ipfsGateway: parsed.IPFS_GATEWAY.replace(/\/$/u, ''),
    healthPort: parsed.INDEXER_HEALTH_PORT,
  });
}
