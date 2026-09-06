import { createServer } from 'node:http';
import process from 'node:process';

import { createPostgresDb, migrate, readCursor } from '@stockpair/core/db';

import { createChainReader } from './chain-reader';
import { loadConfig, loadEnvFiles } from './config';
import { backfillMetadata } from './metadata';
import { refreshStockQuotes } from './quotes';
import { syncOnce } from './sync';

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const db = await createPostgresDb(config.databaseUrl);
  await migrate(db);
  const chain = createChainReader(config.rpcUrls);

  const state = {
    startedAt: new Date().toISOString(),
    lastSync: null as null | Record<string, unknown>,
    lastError: null as null | string,
    head: '0',
    nextBlock: '0',
    quotesUpdatedAt: null as null | string,
  };

  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const lag = BigInt(state.head) - BigInt(state.nextBlock);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...state, lagBlocks: lag < 0n ? '0' : lag.toString() }));
  });
  server.listen(config.healthPort, '127.0.0.1', () => log('health server listening', { port: config.healthPort }));

  let stopped = false;
  const stop = () => {
    stopped = true;
    server.close();
    void db.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let lastQuoteAt = 0;
  log('indexer starting', {
    factory: config.deployment.factory,
    deployBlock: config.deployment.deployBlock.toString(),
    confirmations: config.confirmations,
  });

  while (!stopped) {
    const started = Date.now();
    try {
      if (started - lastQuoteAt > config.quoteIntervalMs) {
        const updated = await refreshStockQuotes(db, chain, config.deployment.factory);
        lastQuoteAt = started;
        state.quotesUpdatedAt = new Date().toISOString();
        log('stock quotes refreshed', { updated });
      }
      const result = await syncOnce({
        db,
        chain,
        deployment: config.deployment,
        confirmations: config.confirmations,
        maxRange: config.maxRange,
        log,
      });
      state.head = (await chain.getBlockNumber()).toString();
      state.nextBlock = (await readCursor(db))?.next_block ?? config.deployment.deployBlock.toString();
      state.lastSync = { ...serialize(result), at: new Date().toISOString() };
      state.lastError = null;
      if (result.status === 'progressed') {
        log('synced', serialize(result));
        if (result.launches > 0) {
          const filled = await backfillMetadata(db, config.ipfsGateway);
          if (filled > 0) log('metadata filled', { filled });
        }
        // Keep going without waiting while we are catching up.
        if (result.toBlock - result.fromBlock + 1n >= BigInt(config.maxRange)) continue;
      } else if (result.status === 'reorg') {
        continue;
      } else {
        const filled = await backfillMetadata(db, config.ipfsGateway, fetch, 5);
        if (filled > 0) log('metadata filled', { filled });
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      log('sync failed', { error: state.lastError });
    }
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, config.pollMs - elapsed)));
  }
}

function serialize(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

await main();
