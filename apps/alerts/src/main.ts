import { createServer } from 'node:http';
import process from 'node:process';

import { createPostgresDb, pruneSentAlerts } from '@stockpair/core/db';

import { loadConfig, loadEnvFiles } from './config';
import { dispatchOnce } from './dispatch';
import { Telegram } from './telegram';

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

/** Once a day is often enough to keep a table of announcements from growing without bound. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  if (!config) {
    // Not an error. A machine that only runs the indexer, or a deploy before the channel exists,
    // is a normal state; crashing on it would turn "no channel yet" into a restart loop.
    log('alerts disabled', { reason: 'TELEGRAM_ALERTS_TOKEN and TELEGRAM_ALERTS_CHANNEL_ID are not both set' });
    return;
  }

  // Its own handle. Every Db serialises its queries through one queue, so sharing the indexer's
  // would let a slow read here sit in front of the chain sync.
  const db = await createPostgresDb(config.databaseUrl, { max: 1 });
  const telegram = new Telegram(config.botToken);

  const state = {
    startedAt: new Date().toISOString(),
    lastPass: null as null | Record<string, unknown>,
    lastError: null as null | string,
    dryRun: config.dryRun,
  };

  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(state));
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

  log('alerts starting', { channel: config.channelId, dryRun: config.dryRun, minTradeUsd: config.minTradeUsd });

  let lastPruneAt = 0;
  while (!stopped) {
    const started = Date.now();
    try {
      const result = await dispatchOnce({ db, telegram, config, log });
      if (result.considered > 0) log('dispatched', { ...result });
      state.lastPass = { ...result, at: new Date().toISOString() };
      state.lastError = null;

      if (started - lastPruneAt > PRUNE_INTERVAL_MS) {
        lastPruneAt = started;
        const pruned = await pruneSentAlerts(db);
        if (pruned > 0) log('pruned', { rows: pruned });
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      log('dispatch failed', { error: state.lastError });
    }
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, config.pollMs - elapsed)));
  }
}

await main();
