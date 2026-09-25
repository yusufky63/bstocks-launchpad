import { createServer } from 'node:http';
import process from 'node:process';

import { createPostgresDb, migrate, readCursor } from '@stockpair/core/db';

import { createChainReader } from './chain-reader';
import { loadConfig, loadEnvFiles } from './config';
import { backfillMetadata, metadataWorker } from './metadata';
import { refreshStockQuotes } from './quotes';
import { catchUpDeployments, DeploymentMismatchError, needsMetadataFetch, syncOnce } from './sync';

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const db = await createPostgresDb(config.databaseUrl, { max: 3 });
  await migrate(db, log);
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
  // A deployment added below the cursor is caught up before the cursor moves again. A pass that
  // fails is retried on the next poll, and the cursor waits for it. A deployment list that does not
  // match the database or the chain is not retried: the process exits and says why.
  let caughtUp = false;
  const metadata = metadataWorker((limit) => backfillMetadata(db, config.ipfsGateway, fetch, { limit }), log);
  const firstBlock = config.deployments[0]!.deployBlock;
  log('indexer starting', {
    deployments: config.deployments.map((d) => ({ factory: d.factory, hook: d.hook, deployBlock: d.deployBlock.toString() })),
    confirmations: config.confirmations,
  });

  while (!stopped) {
    const started = Date.now();
    try {
      if (!caughtUp) {
        const passed = await catchUpDeployments({
          db,
          chain,
          deployments: config.deployments,
          maxRange: config.maxRange,
          log,
        });
        caughtUp = true;
        if (passed.length > 0) log('deployments caught up', { factories: passed.map((d) => d.factory) });
      }
      if (started - lastQuoteAt > config.quoteIntervalMs) {
        // The newest factory is the create target, so it decides which stocks the form offers.
        const updated = await refreshStockQuotes(db, chain, config.deployment.factory);
        lastQuoteAt = started;
        state.quotesUpdatedAt = new Date().toISOString();
        log('stock quotes refreshed', { updated });
      }
      const result = await syncOnce({
        db,
        chain,
        deployments: config.deployments,
        confirmations: config.confirmations,
        maxRange: config.maxRange,
        log,
      });
      state.head = (await chain.getBlockNumber()).toString();
      state.nextBlock = (await readCursor(db))?.next_block ?? firstBlock.toString();
      state.lastSync = { ...serialize(result), at: new Date().toISOString() };
      state.lastError = null;
      if (result.status === 'progressed') {
        log('synced', serialize(result));
        if (needsMetadataFetch(result)) metadata.kick(20);
        // Another writer (a container draining during a deploy) moved the cursor over blocks
        // nobody read for these deployments. Read that stretch now, not on the next restart.
        if (result.deploymentsBehind.length > 0) {
          caughtUp = false;
          log('deployments fell behind the cursor; catching them up', { factories: result.deploymentsBehind });
          continue;
        }
        // Keep going without waiting while we are catching up.
        if (result.toBlock - result.fromBlock + 1n >= BigInt(config.maxRange)) continue;
      } else if (result.status === 'reorg') {
        continue;
      } else {
        metadata.kick(5);
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof DeploymentMismatchError) {
        log('refusing to start', { error: state.lastError });
        process.exit(1);
      }
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
