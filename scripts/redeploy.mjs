#!/usr/bin/env node
/**
 * One command for a fresh contract deployment, from the repository root, in any shell:
 *   node scripts/redeploy.mjs
 * Reads PRIVATE_KEY from .env and the RPC from apps/indexer/.env, broadcasts the Foundry deploy
 * script to Base, writes the new addresses into both env files and resets the database so the
 * indexer starts from the new deploy block. Restart the indexer and the web app afterwards.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
for (const file of ['.env', 'apps/indexer/.env']) {
  const path = resolve(root, file);
  if (existsSync(path)) process.loadEnvFile(path);
}
const key = process.env.PRIVATE_KEY;
const rpc = process.env.BASE_RPC_URL;
if (!key || !rpc) {
  console.error('PRIVATE_KEY (root .env) and BASE_RPC_URL (apps/indexer/.env) are required.');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.filter((a) => a !== key).join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (result.status !== 0) {
    console.error(`\n${cmd} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
};

const contracts = resolve(root, 'packages/contracts');
run('forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', rpc, '--private-key', key, '--broadcast'], { cwd: contracts });
run('node', [resolve(root, 'scripts/apply-deployment.mjs')], { cwd: root });
run('pnpm', ['exec', 'tsx', 'src/db/cli.ts', 'reset'], { cwd: resolve(root, 'packages/core'), env: { ...process.env, CONFIRM_RESET: 'yes' } });
console.log('\nDone. Restart the indexer (pnpm dev:indexer) and the web app (pnpm dev) so they read the new addresses.');
