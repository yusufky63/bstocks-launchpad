import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { DeploymentListError, parseDeployments, type StockPairDeployment } from '@stockpair/core';
import { z } from 'zod';

export type IndexerConfig = Readonly<{
  databaseUrl: string;
  rpcUrls: readonly string[];
  /** Every deployment, oldest first. Earlier ones stay live, so all of them are indexed. */
  deployments: readonly StockPairDeployment[];
  /** The newest deployment: the only one that takes new launches, and the one stocks are mirrored from. */
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
  const help =
    'Set STOCKPAIR_DEPLOYMENTS, a JSON list of {factory, hook, router, deployBlock} oldest first, or ' +
    'STOCKPAIR_FACTORY, STOCKPAIR_HOOK, STOCKPAIR_ROUTER and STOCKPAIR_DEPLOY_BLOCK. A list that does ' +
    'not parse, repeats a factory or hook, or goes back in deploy block is refused whole.';
  let deployments: readonly StockPairDeployment[];
  try {
    deployments = parseDeployments(env, 'STOCKPAIR');
  } catch (error) {
    if (error instanceof DeploymentListError) throw new Error(`Refusing to start: ${error.message} ${help}`);
    throw error;
  }
  const deployment = deployments.at(-1);
  if (!deployment) throw new Error(help);
  return Object.freeze({
    databaseUrl: parsed.DATABASE_URL,
    rpcUrls: [parsed.BASE_RPC_URL, ...(parsed.BASE_RPC_URL_FALLBACK ? [parsed.BASE_RPC_URL_FALLBACK] : [])],
    deployments,
    deployment,
    confirmations: parsed.INDEXER_CONFIRMATIONS,
    pollMs: parsed.INDEXER_POLL_MS,
    maxRange: parsed.INDEXER_MAX_RANGE,
    quoteIntervalMs: parsed.INDEXER_QUOTE_INTERVAL_MS,
    ipfsGateway: parsed.IPFS_GATEWAY.replace(/\/$/u, ''),
    healthPort: parsed.INDEXER_HEALTH_PORT,
  });
}
